/** `cost` namespace dictionaries (the composer dock cost line's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'line': '预估费用 {cost}{percent}',
  'breakdown': '按配置费率估算（非账单数值）：{input} 无缓存输入 · {cache} 缓存读取 · {write} 缓存写入 · {output} 输出',
  'budget': '约占每周预算（{budget}）的 {percent}',
} satisfies Record<string, string>

/** The cost namespace key union. */
export type CostKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'line': 'est. cost {cost}{percent}',
  'breakdown': 'Estimated at the configured rates (not a billing figure): {input} uncached in · {cache} cached read · {write} cache write · {output} out',
  'budget': 'about {percent} of the {budget} weekly budget',
} satisfies Record<CostKey, string>
