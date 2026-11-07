/**
 * 应用版本号（单一出口）。
 * Workers 里不能 fs 读 package.json，`import ... with { type: 'json' }` 又会把 Node 下限抬到 20.10，
 * 所以这里显式写一份；升级版本时同步改 package.json 的 version。
 */
export const APP_VERSION = '2.4.0';
