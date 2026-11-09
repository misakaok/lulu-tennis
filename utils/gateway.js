// 数据网关：模拟 wx.cloud.database() 里 db.js 用到的那一小部分接口，实际都通过云函数 tennis 的 data 操作完成。
// 所有集合在控制台都是「仅管理端可读写」——小程序端不能直接读写数据库，必须是正式成员、经云函数校验。
const cloud = require('./cloud');

const call = (payload) => cloud.call('data', payload);

function query(coll, st) {
  const q = (more) => query(coll, Object.assign({}, st, more));
  return {
    where: (w) => q({ where: w }),
    orderBy: (f, d) => q({ orders: (st.orders || []).concat([[f, d]]) }),
    skip: (n) => q({ skip: n }),
    limit: (n) => q({ limit: n }),
    get: () => call({ op: 'get', coll, where: st.where, orders: st.orders, skip: st.skip, limit: st.limit }).then((r) => ({ data: r.data })),
    count: () => call({ op: 'count', coll, where: st.where }).then((r) => ({ total: r.total })),
    add: ({ data }) => call({ op: 'add', coll, data }).then((r) => ({ _id: r._id })),
    doc: (id) => ({
      get: () => call({ op: 'doc', coll, id }).then((r) => ({ data: r.data })),
      update: ({ data }) => call({ op: 'update', coll, id, data }).then((r) => ({ stats: r.stats })),
      remove: () => call({ op: 'remove', coll, id }).then((r) => ({ stats: r.stats })),
    }),
  };
}

const gateway = {
  collection: (name) => query(name, {}),
  serverDate: () => ({ __serverDate: 1 }),
  command: { set: (v) => ({ __cmd: 'set', v }) },
};

module.exports = gateway;
