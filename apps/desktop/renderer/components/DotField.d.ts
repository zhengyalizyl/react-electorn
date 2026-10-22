// DotField.jsx 是通过
//   pnpm dlx shadcn@latest add @react-bits/DotField-JS-CSS
// 装进来的第三方组件（React Bits），本身没有类型。
//
// 类型写在这个旁路声明文件里，而不是去改那个 .jsx——改了下次升级会被覆盖。
// 属性表与默认值对照 DotField.jsx 顶部的解构默认值。

import type { ComponentPropsWithoutRef, JSX, MemoExoticComponent } from 'react';

export interface DotFieldProps extends ComponentPropsWithoutRef<'div'> {
    /** 点半径，默认 1.5 */
    dotRadius?: number;
    /** 点间距，默认 14。实际步长是 dotRadius + dotSpacing */
    dotSpacing?: number;
    /** 光标影响半径，默认 500 */
    cursorRadius?: number;
    /** bulgeOnly 为 false 时的推力系数，默认 0.1 */
    cursorForce?: number;
    /** true=光标附近的点向外凸起；false=按鼠标速度推开并带惯性。默认 true */
    bulgeOnly?: boolean;
    /** 凸起强度，默认 67 */
    bulgeStrength?: number;
    /** 跟随光标的柔光半径，默认 160 */
    glowRadius?: number;
    /** 随机让少量点变大，默认 false */
    sparkle?: boolean;
    /** 整体波动幅度，0 为不波动。默认 0 */
    waveAmplitude?: number;
    /** 点阵渐变起始色，默认 'rgba(168, 85, 247, 0.35)' */
    gradientFrom?: string;
    /** 点阵渐变结束色，默认 'rgba(180, 151, 207, 0.25)' */
    gradientTo?: string;
    /** 柔光颜色，默认 '#120F17' */
    glowColor?: string;
}

declare const DotField: MemoExoticComponent<
    (props: DotFieldProps) => JSX.Element
>;

export default DotField;
