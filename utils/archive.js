// 成长档案的数据读写（私人比赛记录，只有本人可见）：一律经云函数，身份由云端 OPENID 决定。
// 列表在内存里缓存 60 秒（cloud.cached）；保存、删除、清除都是写操作，成功后自动作废缓存（utils/cloud.js）。
// 不写本机存储：私人记录不落地到手机缓存里。
const cloud = require('./cloud');

// 云函数还是旧版本（没有这些操作）时返回「未知操作」：换成用户看得懂的提示
const friendly = (e) => { throw /未知操作/.test((e && e.message) || '') ? new Error('这个功能正在更新，请稍后再试') : e; };
const list = () => cloud.cached('growthList').then((r) => r.list || [], friendly);
// 同步取 60 秒内读过的列表（只在内存，cloud.peek；任何写操作、下拉刷新都会作废）：打开页面先画，没有返回 null。不读写本机存储
const peek = () => { const r = cloud.peek ? cloud.peek('growthList') : undefined; return r ? r.list || [] : null; };
const save = (id, record) => cloud.call('growthSave', { id: id || '', record }).then((r) => r.id);
const remove = (id) => cloud.call('growthRemove', { id });
const clear = () => cloud.call('growthClear', { confirm: true }).then((r) => r.removed || 0);

module.exports = { list, peek, save, remove, clear };
