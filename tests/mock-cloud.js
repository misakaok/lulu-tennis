// 内存版 wx-server-sdk：只实现云函数 tennis 用到的那部分接口，用来在 Node 里直接跑真实的云函数代码。
// 用法：const env = require('./mock-cloud')(); const fn = env.load(); await env.call(uid, 'action', data)
const Module = require('module');
const path = require('path');

const FN_PATH = path.resolve(__dirname, '../cloudfunctions/tennis/index.js');

module.exports = function createEnv() {
  const env = { store: {}, openid: '', queries: 0, clock: 1000, deletedFiles: [], deleteFails: [], sent: [], subscribed: {} };
  const IN = Symbol('in'), NEQ = Symbol('neq'), GT = Symbol('gt'), REMOVE = Symbol('remove');
  const SD = { serverDate: true };
  const coll = (n) => (env.store[n] = env.store[n] || {});
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const match = (doc, w) => Object.keys(w || {}).every((k) => {
    const v = w[k], d = doc[k];
    if (v && v[IN]) return v.list.includes(d);
    if (v && v[NEQ]) return JSON.stringify(d) !== JSON.stringify(v.v);
    if (v && v[GT]) return typeof d === 'number' && d > v.v;
    if (Array.isArray(d) && !Array.isArray(v)) return d.includes(v);
    return JSON.stringify(d) === JSON.stringify(v);
  });
  const applyData = (doc, data) => {
    Object.keys(data).forEach((k) => {
      const v = data[k];
      if (v && v[REMOVE]) delete doc[k];
      else doc[k] = v === SD ? ++env.clock : v && v.__set ? clone(v.v) : clone(v === undefined ? null : v);
    });
    return doc;
  };
  const cmp = (x, y) => (x === y ? 0 : x === undefined || x === null ? -1 : y === undefined || y === null ? 1 : x < y ? -1 : 1);
  function query(n, st) {
    const q = (m) => query(n, Object.assign({}, st, m));
    const rows = () => {
      const r = Object.values(coll(n)).filter((d) => match(d, st.where));
      const orders = st.orders || [];
      if (orders.length) r.sort((x, y) => { for (const [f, dir] of orders) { const c = cmp(x[f], y[f]); if (c) return dir === 'desc' ? -c : c; } return 0; });
      return r;
    };
    return {
      where: (w) => q({ where: w }), orderBy: (f, d) => q({ orders: (st.orders || []).concat([[f, d]]) }), skip: (s) => q({ skip: s }), limit: (l) => q({ limit: l }),
      get: async () => { env.queries++; return { data: clone(rows().slice(st.skip || 0, (st.skip || 0) + (st.limit || 100))) }; },
      count: async () => { env.queries++; return { total: rows().length }; },
      update: async ({ data }) => { const r = rows(); r.forEach((d) => applyData(d, data)); return { stats: { updated: r.length } }; },
      remove: async () => { const r = rows(); r.forEach((d) => delete coll(n)[d._id]); return { stats: { removed: r.length } }; },
      add: async ({ data }) => {
        const id = data._id || 'auto' + ++env.clock;
        if (coll(n)[id]) throw new Error('duplicate key');
        coll(n)[id] = applyData({ _id: id }, data);
        return { _id: id };
      },
      doc: (id) => ({
        get: async () => { env.queries++; if (!coll(n)[id]) throw new Error('document not exist'); return { data: clone(coll(n)[id]) }; },
        set: async ({ data }) => { coll(n)[id] = applyData({ _id: id }, data); return {}; },
        update: async ({ data }) => { if (!coll(n)[id]) throw new Error('document not exist'); applyData(coll(n)[id], data); return { stats: { updated: 1 } }; },
        remove: async () => { if (!coll(n)[id]) throw new Error('document not exist'); delete coll(n)[id]; return { stats: { removed: 1 } }; },
      }),
    };
  }
  const command = {
    in: (list) => ({ [IN]: true, list }), neq: (v) => ({ [NEQ]: true, v }), gt: (v) => ({ [GT]: true, v }),
    set: (v) => ({ __set: 1, v }), remove: () => ({ [REMOVE]: true }),
  };
  const sdk = {
    DYNAMIC_CURRENT_ENV: 'dyn', init() {},
    database: () => ({ collection: (n) => query(n, {}), serverDate: () => SD, command }),
    getWXContext: () => ({ OPENID: env.openid, ENV: 'env1' }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map((f) => ({ fileID: f.fileID, status: 0, tempFileURL: 'https://tmp/' + f.fileID })) }),
    // 删除文件：env.deleteFails 里的 fileID 返回失败，其余成功；删除记录在 env.deletedFiles
    deleteFile: async ({ fileList }) => ({ fileList: fileList.map((fileID) => {
      if ((env.deleteFails || []).indexOf(fileID) >= 0) return { fileID, status: -1, errMsg: 'mock fail' };
      env.deletedFiles.push(fileID); return { fileID, status: 0 };
    }) }),
    openapi: {
      security: {},
      // 订阅消息：env.subscribed[uid] 为 true 才算发送成功，否则返回 43101（用户没订阅）；发送记录在 env.sent
      subscribeMessage: { send: async (msg) => { if (!env.subscribed[msg.touser]) throw Object.assign(new Error('user refuse to accept the msg'), { errCode: 43101 }); env.sent.push(msg); return { errCode: 0 }; } },
    },
  };

  env.coll = coll;
  env.put = (n, doc) => { coll(n)[doc._id] = clone(doc); return doc; };
  // notifyConfig：传入时替换 notify-config.js（测试订阅消息用）
  env.load = (file, notifyConfig) => {
    const target = file || FN_PATH;
    const cfgPath = path.join(path.dirname(target), 'notify-config.js');
    if (notifyConfig) require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: notifyConfig };
    else delete require.cache[cfgPath];
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, ...a) { return req === 'wx-server-sdk' ? 'wx-server-sdk' : orig.call(this, req, ...a); };
    require.cache['wx-server-sdk'] = { id: 'wx-server-sdk', filename: 'wx-server-sdk', loaded: true, exports: sdk };
    delete require.cache[target];
    try { env.fn = require(target); } finally { Module._resolveFilename = orig; }
    return env.fn;
  };
  env.call = async (uid, action, data) => {
    env.openid = uid;
    env.queries = 0;
    return env.fn.main(Object.assign({ action }, data || {}));
  };
  // 常用初始数据：几位正式成员（含本人资料），并标记旧记录已迁移
  env.members = (list) => {
    env.put('verified', { _id: '__legacy_migrated__' });
    list.forEach(([uid, name], i) => {
      env.put('members', { _id: uid, status: 'active' });
      if (name) env.put('players', { _id: 'p_' + uid, _openid: uid, self: true, name, createdAt: i + 1 });
    });
  };
  return env;
};
