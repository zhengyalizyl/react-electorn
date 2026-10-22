import { useNavigate } from 'react-router-dom';

import CreateHero from '@/renderer/components/create/CreateHero';
import ScriptCard from '@/renderer/components/create/ScriptCard';
import DotField from '@/renderer/components/DotField';
import { useMediaLibrary } from '@/renderer/data/use-media-library';

/**
 * 创作页。
 *
 * 对应 magicut-demo.pen 的 frame HzNgd（妙剪 Magicut — 创作页-输入文稿）。
 *
 * 侧栏由 WorkspaceLayout 提供，与项目页共用同一个实例——设计稿里两页的侧栏
 * 逐像素相同，只有胶囊导航的选中项不同，而那个由 NavLink 按当前路由自己判断。
 *
 * 页面底色、侧栏配色复用 pj-*；这页独有的卡片/输入/下拉配色是 cr-*。
 *
 * **「创建」跳到创作进行页**（`/creating`），真正的运行在那一页发起：
 * 主进程里的 LangGraph 图从提示词一路做到落盘 `project.json`，
 * 中途在两个中断点等确认（plan.md §6）。这一页到此为止，不再管进度——
 * 跑起来之后文稿已经发出去了，还把它留在可编辑的输入框旁边只会误导人。
 */
export default function CreatePage() {
    // 每次进创作页都从"什么都没选"开始：从项目页切回来时，
    // 旁边还挂着上一条片子选的素材，那不是这次的状态
    const media = useMediaLibrary({ resetOnMount: true });
    const navigate = useNavigate();

    return (
        <main
            id="workspace-panel-create"
            role="tabpanel"
            aria-label="创作"
            className="flex min-w-0 flex-1 flex-col items-center gap-[66px] overflow-y-auto px-10 pt-40 pb-16 scrollbar-ed"
        >
            <CreateHero />

            {/* 点阵特效垫在卡片背后：上下居中对准卡片，横向铺满内容区，
                两端用 mask 渐隐避免生硬的矩形边。
                卡片底色不透明，所以输入框里看不到点——特效只在卡片周围显现。 */}
            <div className="relative isolate flex w-full justify-center">
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-0 -z-10 h-[220px] w-full -translate-y-1/2 [mask-image:linear-gradient(to_right,transparent,black_18%,black_82%,transparent)]"
                >
                    <DotField
                        dotSpacing={16}
                        cursorRadius={320}
                        bulgeStrength={44}
                        gradientFrom="rgba(138, 92, 255, 0.40)"
                        gradientTo="rgba(240, 106, 176, 0.26)"
                        glowColor="#2A1B4A"
                    />
                </div>

                <ScriptCard
                    media={media}
                    onCreate={({ script, voiceId }) =>
                        navigate('/creating', { state: { script, voiceId } })
                    }
                />
            </div>
        </main>
    );
}
