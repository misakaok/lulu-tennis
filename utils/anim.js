// 数字滚动：场数、胜率、等级分第一次显示时从 0 滚到实际值（纯展示，不改数据）。
// 用法：把起始帧并进渲染的那一次 setData（路径写在整块数据后面，会盖住对应字段）
//   this.setData(Object.assign({ me }, Anim.roll(this, { 'me.played': me.played, 'me.rate': me.rate })));
// 每个页面 / 组件实例只滚一次；滚动中又有新的渲染时（再次调用 roll，比如先用本机缓存画、云端读完又画一次）
// 接着滚到新的值，不跳到终点再停（2026-11-25 用户嫌数字闪一下）。
// 战绩、排行 tab 切走再回来重播一次（页面实例不会重建）：onHide 调 leave，onShow 调 enter；
// 页面上的入场动画类写成 {{play ? 'ani-in' : 'ani-wait'}}（进度条 ani-grow-x / ani-wait-x），data 里 play 默认 true。
// 球拍页不重播（2026-11-25 用户觉得动画太多，只要战绩、排行还原）。
const MS = 750;   // 总时长
const STEP = 28;  // 每帧间隔（逻辑层没有 requestAnimationFrame）；28ms 兼顾 iOS 顺滑和中低端安卓 setData 的通信开销

const ease = (t) => 1 - Math.pow(1 - t, 4); // 快起慢刹（4 次方减速）

// 把文字里的每个数字按进度 t（0～1）缩小，小数位数不变：'12胜 5负' → '6胜 3负'，'3.52' → '1.76'
function rollText(v, t) {
  return String(v).replace(/\d+(\.\d+)?/g, (m, dec) => {
    const n = parseFloat(m) * t;
    return dec ? n.toFixed(dec.length - 1) : String(Math.round(n));
  });
}

function frame(values, t) {
  const out = {};
  Object.keys(values).forEach((k) => { out[k] = t >= 1 ? values[k] : rollText(values[k], t); });
  return out;
}

function stop(ctx) {
  if (ctx._rollTimer) { clearTimeout(ctx._rollTimer); ctx._rollTimer = null; }
  if (ctx._leaveTimer) { clearTimeout(ctx._leaveTimer); ctx._leaveTimer = null; }
}

// values：{ 数据路径: 最终值 }。返回要并进同一次 setData 的起始帧；不需要滚动时返回 {}
function pickNums(values) {
  const target = {};
  Object.keys(values || {}).forEach((k) => { if (/[1-9]/.test(String(values[k]))) target[k] = values[k]; });
  return target;
}

function roll(ctx, values) {
  ctx._rollValues = values || {};
  if (ctx._replay) { if (ctx._rollTimer) { clearTimeout(ctx._rollTimer); ctx._rollTimer = null; } return frame(pickNums(values), 0); } // 切走期间又渲染了：先停在 0，回来时再滚
  if (ctx._rollTimer) { // 正在滚：换成新的终点接着滚，这次 setData 里放当前进度的那一帧（不让整块数据把数字一下子盖成终值）
    ctx._rollTarget = pickNums(values);
    return frame(ctx._rollTarget, ease(Math.min(1, (Date.now() - ctx._rollStart) / MS)));
  }
  if (ctx._rolled) return {};
  const target = pickNums(values);
  if (!Object.keys(target).length) return {}; // 还没有数据（都是 0 或「暂无」）：等有数据的那次渲染再滚
  ctx._rolled = true;
  ctx._rollTarget = target;
  ctx._rollStart = Date.now();
  const tick = () => {
    const t = Math.min(1, (Date.now() - ctx._rollStart) / MS);
    ctx.setData(frame(ctx._rollTarget, ease(t)));
    ctx._rollTimer = t < 1 ? setTimeout(tick, STEP) : null;
  };
  ctx._rollTimer = setTimeout(tick, STEP);
  return frame(target, 0);
}

// 是不是只被新打开的子页面盖住（点进详情）：这种情况返回时保持原样，不重播
function covered(ctx) {
  try {
    const ps = getCurrentPages();
    return ps.indexOf(ctx) >= 0 && ps[ps.length - 1] !== ctx;
  } catch (e) { return false; }
}

// onHide：切换 tab、退到后台时把页面恢复成「入场前」（动画类换成等待态、数字归 0），回来时再播。
// 点进详情页时 onHide 可能比新页面进页面栈早，当时看不出是被盖住：这时先不动，等 LEAVE_MS 再看一次，
// 那时还没被子页面盖住（切了 tab、退到后台）才恢复成入场前；期间已经回来（onShow）就什么都不做。
// 不然从详情返回会把整页动画重播一遍（2026-11-25 用户说返回战绩页闪一下）
const LEAVE_MS = 200;
function reset(ctx) {
  stop(ctx);
  ctx._replay = true;
  ctx.setData(Object.assign({ play: false }, frame(pickNums(ctx._rollValues), 0)));
}
function leave(ctx) {
  clearTimeout(ctx._leaveTimer);
  ctx._leaveTimer = null;
  if (covered(ctx)) return;
  ctx._leaveTimer = setTimeout(() => { ctx._leaveTimer = null; if (!covered(ctx)) reset(ctx); }, LEAVE_MS);
}

// onShow：要重播时，先确认「入场前」那一帧已经画到屏幕上（setData 回调），再加上动画类、数字从 0 滚到当前值。
// 页面藏着时的 setData 不一定马上画出来：要是「入场前」和「重播」挤在同一帧，动画会接不上、卡片上下弹两下
// （2026-11-25 用户快速点 tab 时看到）。自己 setData，返回 {}（页面照旧可以把返回值并进 setData）
function enter(ctx) {
  if (ctx._leaveTimer) { clearTimeout(ctx._leaveTimer); ctx._leaveTimer = null; } // 刚离开又回来（还没恢复成入场前）：保持原样
  if (!ctx._replay) return {};
  ctx._replay = false;
  ctx._rolled = false;
  const seq = (ctx._enterSeq || 0) + 1;
  ctx._enterSeq = seq;
  ctx.setData(Object.assign({ play: false }, frame(pickNums(ctx._rollValues), 0)), () => {
    if (ctx._enterSeq !== seq || ctx._replay) return; // 这期间又切走了：等下次回来再播
    ctx.setData(Object.assign({ play: true }, roll(ctx, ctx._rollValues)));
  });
  return {};
}

// 一次启动只播一次的效果（比如每次打开比赛详情都扫一道高光太闪）：第一次返回 true，之后都是 false
const onceSeen = {};
function once(key) { if (onceSeen[key]) return false; onceSeen[key] = true; return true; }

module.exports = { roll, stop, leave, enter, once, rollText, MS, LEAVE_MS, ease };
