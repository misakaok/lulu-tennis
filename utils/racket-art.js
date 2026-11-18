// 球拍示意图的配色（组件 components/rk-art）：按品牌 / 系列给一套颜色，画一支通用的球拍，不画品牌标志、不用产品图。
//   f 拍框主色、a 点缀色（拍框色带、拍喉和拍尾）、g 手柄颜色。只是「大致像这个系列」的示意，不对应具体代数和配色。
//   型号选「其他」或没有专门配色时用品牌的默认配色（_）；还没选品牌时用主题淡紫。
//   只在小程序端用，不进云函数（不用 sync-shared）。
const DARK = '#2B2B33';
const ART = {
  wilson: {
    _: { f: '#2B2B33', a: '#C8202E' },
    'Pro Staff': { f: '#1E1E22', a: '#B89B5E' },
    Blade: { f: '#1F5A4A', a: '#9CC3B2' },
    Clash: { f: '#C4262E', a: '#1E1E22' },
    Ultra: { f: '#1F6FB2', a: '#0E2A4A' },
    Shift: { f: '#D9D2E8', a: '#7A4FBF' },
    Burn: { f: '#E8641B', a: '#1E1E22' },
    'Six.One': { f: '#1E1E22', a: '#C0392B' },
  },
  head: {
    _: { f: '#2B2B33', a: '#E8E8EE' },
    Speed: { f: '#D8D8DF', a: '#1E1E22', g: '#E4E4EA' },
    Radical: { f: '#F07A1A', a: '#1B2A4A' },
    Prestige: { f: '#7A1F2B', a: '#1E1E22' },
    Extreme: { f: '#E3DF1E', a: '#1E1E22' },
    Gravity: { f: '#1D8F9A', a: '#E2574C' },
    Boom: { f: '#3AB5B0', a: '#233B6E' },
    Instinct: { f: '#1F5FBF', a: '#7FD3FF' },
  },
  babolat: {
    _: { f: '#1569C7', a: '#1E1E22' },
    'Pure Aero': { f: '#F2D21B', a: '#1E1E22' },
    'Pure Drive': { f: '#1569C7', a: '#0E1F3D' },
    'Pure Strike': { f: '#D8D8DF', a: '#D62D2D' },
    'Evo Drive': { f: '#2C7BE5', a: '#F0F0F2' },
    Boost: { f: '#7B3FBF', a: '#F2D21B' },
  },
  yonex: {
    _: { f: '#1E5BD6', a: '#F0F0F2' },
    EZONE: { f: '#1E5BD6', a: '#8FD3FF' },
    VCORE: { f: '#D62A2A', a: '#1E1E22' },
    Percept: { f: '#3D5A3B', a: '#C6A94C' },
    Astrel: { f: '#EFA3BC', a: '#FFFFFF', g: '#E4E4EA' },
  },
  prince: {
    _: { f: '#2A2A2A', a: '#E94E1B' },
    Phantom: { f: '#2B2B2B', a: '#D9A441' },
    Tour: { f: '#2A2A2A', a: '#E94E1B' },
    Textreme: { f: '#1C3A6E', a: '#D6D6D6' },
    Ripstick: { f: '#1E1E22', a: '#2E7D32' },
  },
  tecnifibre: {
    _: { f: '#1E1E22', a: '#E03C31' },
    TFight: { f: '#1E1E22', a: '#E03C31' },
    TF40: { f: '#142A4F', a: '#F0F0F2' },
    Tempo: { f: '#D8D8DF', a: '#E88AA8', g: '#E4E4EA' },
    'TF-X1': { f: '#2B2B2B', a: '#2FB5E8' },
  },
  dunlop: {
    _: { f: '#1E1E22', a: '#D0202E' },
    CX: { f: '#1E1E22', a: '#D0202E' },
    SX: { f: '#F2C500', a: '#1E1E22' },
    FX: { f: '#1D4FA3', a: '#F0F0F2' },
  },
  volkl: {
    _: { f: '#1E1E22', a: '#F28C28' },
    'V-Cell': { f: '#1E1E22', a: '#F28C28' },
    'V-Feel': { f: '#D3CCBD', a: '#1E1E22' },
    Vostra: { f: '#B0B0B0', a: '#E2232A' },
  },
  diadem: {
    _: { f: '#20232A', a: '#3AA0FF' },
    Nova: { f: '#20232A', a: '#3AA0FF' },
    Elevate: { f: '#1E1E22', a: '#7ED957' },
    Rise: { f: '#D8D8DF', a: '#3AA0FF' },
  },
  other: { _: { f: '#6E6EA3', a: '#C9E33A' } },
};
const NONE = { f: '#A3A3CB', a: '#6E6EA3', g: '#4F4F7D' }; // 还没选品牌

function artOf(brand, model) {
  const b = ART[brand];
  if (!b) return NONE;
  const c = b[model] || b._;
  return { f: c.f, a: c.a, g: c.g || DARK };
}

module.exports = { ART, artOf };
