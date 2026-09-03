/** `coding-timer` namespace dictionaries: the sidebar timer row, its totals calendar, and the focus-gate cover. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'start': '开始编码',
  'stop': '停止编码',
  'info': '编码时长统计',
  'today': '今天',
  'thisWeek': '本周',
  'month.title': '{year}年{month}月',
  'month.prev': '上个月',
  'month.next': '下个月',
  'wd.1': '一',
  'wd.2': '二',
  'wd.3': '三',
  'wd.4': '四',
  'wd.5': '五',
  'wd.6': '六',
  'wd.7': '日',
  'duration.hm': '{h} 小时 {m} 分',
  'duration.m': '{m} 分钟',
  'duration.zero': '0 分钟',
  'week.total': '周总计',
  'gate.today': '今天已编码',
  'gate.disable': '保持界面常显',
  'gate.toggle': '停止时显示开始界面',
  'gate.on': '已开启',
  'gate.off': '已关闭',
  'idle.label': '无操作自动停止',
  'idle.minutes': '分钟',
} satisfies Record<string, string>

/** The coding-timer namespace key union. */
export type CodingTimerKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'start': 'Start coding',
  'stop': 'Stop coding',
  'info': 'Coding time stats',
  'today': 'Today',
  'thisWeek': 'This week',
  'month.title': '{year}-{month}',
  'month.prev': 'Previous month',
  'month.next': 'Next month',
  'wd.1': 'Mon',
  'wd.2': 'Tue',
  'wd.3': 'Wed',
  'wd.4': 'Thu',
  'wd.5': 'Fri',
  'wd.6': 'Sat',
  'wd.7': 'Sun',
  'duration.hm': '{h}h {m}m',
  'duration.m': '{m}m',
  'duration.zero': '0m',
  'week.total': 'Week',
  'gate.today': 'Coded today',
  'gate.disable': 'Keep the UI always visible',
  'gate.toggle': 'Show the start screen while stopped',
  'gate.on': 'On',
  'gate.off': 'Off',
  'idle.label': 'Auto-stop when idle for',
  'idle.minutes': 'min',
} satisfies Record<CodingTimerKey, string>
