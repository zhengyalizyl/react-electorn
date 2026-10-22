/**
 * 「什么时候改的」这句话。
 *
 * ## 为什么要有这个文件
 *
 * 设计稿上写的是「2 分钟前更新」和「6月10日 17:42」——那是**画稿那天的占位**。
 * 照搬进代码，界面就会对每一条片子都说同一句话，而那句话是假的：
 * 用户昨天建的工程，今天打开仍然写着「2 分钟前更新」。
 *
 * 死按钮至多是没用，**假数据是在骗人**，后者糟得多。所以这里按工程里的
 * `updatedAt` 真算一遍。
 *
 * ## 为什么近处说相对时间、远处说日期
 *
 * 刚改完那几分钟里，「3 分钟前」比「10月8日 14:21」有用得多；
 * 而三个月前的工程说「129600 分钟前」纯属折磨人。换挡点放在一天：
 * 一天以内相对，超过一天报日期。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * @param iso 工程的 `updatedAt`。拿不到时返回 null——
 *            **不编一个时间**，调用方自己决定这种情况显示什么
 * @param now 当前时刻，注入是为了测试能稳定断言
 */
export function formatUpdatedAt(
    iso: string | null | undefined,
    now: Date = new Date()
): string | null {
    if (!iso) return null;

    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;

    const diff = now.getTime() - at.getTime();

    // 时钟偏差、或者工程来自另一台机器时，差值可能是负的。
    // 「-3 分钟前更新」只会让人以为程序坏了，当成刚刚处理
    if (diff < MINUTE) return '刚刚更新';
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前更新`;
    if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前更新`;

    return `${at.getMonth() + 1}月${at.getDate()}日 ${String(
        at.getHours()
    ).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 更新`;
}
