// 列表数据的内存缓存：减少云函数调用（每次分页读取都是一次云函数调用）
//   - 同一个请求正在进行时，再调用直接复用，不重复发
//   - 结果在内存里保留 TTL_MS；切换 tab、从子页面返回时不再重新拉取
//   - 自己写入后（经 utils/cloud.js 的任何写操作）按集合或全部作废；下拉刷新时全部作废
// 只放内存，不写本机存储（本机存储另有受成员资格保护的缓存，见 utils/db.js）
const TTL_MS = 60 * 1000;
const store = {}; // key → { at, value, task, coll }

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v))); // 调用方改了数据也不会污染缓存

// 取原始结果（不复制）：只给 utils/db.js 内部做二次整理用，调用方不能修改返回值。
// deps：这条结果是由哪些缓存算出来的（key 数组）。它的有效期从其中最早的一条算起，
//   保证「整理后的结果」不会比它依赖的原始数据活得更久。
function raw(key, coll, fn, deps) {
  const e = store[key];
  if (e && e.task) return e.task;
  if (e && Date.now() - e.at < TTL_MS) return Promise.resolve(e.value);
  const entry = { coll, at: 0, value: undefined, task: null };
  store[key] = entry;
  entry.task = Promise.resolve().then(fn).then((v) => {
    if (store[key] === entry) {
      let at = Date.now();
      (deps || []).forEach((d) => { const x = store[d]; if (x && !x.task && x.at < at) at = x.at; });
      entry.value = v; entry.at = at; entry.task = null;
    }
    return v;
  }, (err) => {
    if (store[key] === entry) delete store[key];
    throw err;
  });
  return entry.task;
}

function get(key, coll, fn, deps) { return raw(key, coll, fn, deps).then(clone); }

const ANY = '*'; // coll 传 ANY：任何集合变了都作废（云函数只读操作的结果，说不清依赖哪些集合）

// 作废某些集合（不传就全部作废）。一条缓存可以依赖多个集合（coll 传数组），任一集合变了就作废
function invalidate(colls) {
  const set = colls ? [].concat(colls) : null;
  Object.keys(store).forEach((k) => {
    if (!set || [].concat(store[k].coll).some((c) => c === ANY || set.indexOf(c) >= 0)) delete store[k];
  });
}

module.exports = { get, raw, invalidate, TTL_MS, ANY };
