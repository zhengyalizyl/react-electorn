import {
    createHashRouter,
    Navigate,
    type RouteObject,
    useLocation,
    useNavigate,
    useParams
} from 'react-router-dom';

import { hasBridge, projectBridge } from '../data/bridge';
import { useProject } from '../data/use-project';
import type { CreatingHandoff } from '../pages/CreatingPage';
import CreatingPage from '../pages/CreatingPage';
import EditorPage from '../pages/EditorPage';
import RouteError from '../pages/RouteError';
import WorkspaceLayout from '../pages/WorkspaceLayout';

/**
 * 编辑器的路由入口，`/`、`/editor`、`/editor/:projectId` 三条都走它。
 *
 * 这里目前只做一件路由层的事：注入「回首页」的导航。
 *
 * ⚠️ `:projectId` 暂时**没有被消费**。B11 才把它换成真的加载 `project.json`；
 * 在那之前从路由参数硬猜标题只会给人「已经接上了」的错觉。
 *
 * 解析与导航都不放进页面里，EditorPage 才能脱离 Router 直接渲染，
 * 组件测试不用为了这两样去套 RouterProvider。
 */
function EditorRoute() {
    // `:projectId` 其实是工程**目录名**——工程 id 在 JSON 里，
    // 而路由要能在不读文件的情况下定位，所以用目录名
    const { projectId } = useParams();
    const navigate = useNavigate();
    const { reload, ...state } = useProject(projectId);
    // 刚跑完一条片子跳过来时停在「口播」；平时打开工程还是默认「画面」
    const fresh = (useLocation().state as { justCreated?: boolean } | null)
        ?.justCreated;
    const initialTab = fresh === true ? ('voice' as const) : undefined;

    // 设计稿里没有「首页」这一页，侧栏导航里的首页也标着未实现。
    // 工作台是目前唯一的落地页，先指到它；有了真正的首页改这一行即可。
    const home = () => navigate('/workspace');

    // 四种状态各说各的话。统一成"空"会让人以为工程丢了
    switch (state.status) {
        case 'ready':
            return (
                <EditorPage
                    project={state.project}
                    projectId={projectId}
                    onHome={home}
                    initialTab={initialTab}
                    {...(projectId
                        ? {
                              onRequest: async (input) => {
                                  const bridge = projectBridge();
                                  // 没有桥（浏览器）时什么都不做：写不进去就别假装写了
                                  if (!bridge) return;
                                  await bridge.request(projectId, input);
                                  // 重新读一遍，让"已记下 N 条"跟上
                                  reload();
                              },
                              /**
                               * 字幕样式落盘。
                               *
                               * **不 `reload()`**：界面上显示的已经是改完的样子，
                               * 重读一遍只会让预览闪一下，还可能把用户在这几百毫秒里
                               * 又改的那一下冲掉。失败由 EditorPage 接住并说出来。
                               */
                              onSubtitleStyleSave: async ({
                                  styleId,
                                  style
                              }) => {
                                  const bridge = projectBridge();
                                  if (!bridge) return;
                                  await bridge.saveSubtitleStyle(
                                      projectId,
                                      styleId,
                                      style
                                  );
                              },
                              /** 口播音量同理：改完就写，不 reload */
                              onVoiceGainSave: async ({ gainDb }) => {
                                  const bridge = projectBridge();
                                  if (!bridge) return;
                                  await bridge.saveVoiceGain(projectId, gainDb);
                              },
                              /**
                               * 改过结构（分割）就整份写回去。
                               *
                               * **同样不 reload**：界面上那份已经是切完的样子，
                               * 重读只会闪一下；而且主进程写前会过一遍九条不变量，
                               * 不合法根本落不了盘。
                               */
                              onProjectSave: async (next) => {
                                  const bridge = projectBridge();
                                  if (!bridge) return;
                                  await bridge.save(projectId, next);
                              }
                          }
                        : {})}
                />
            );
        case 'loading':
            // **每个分支都要带上 initialTab**：加载中先挂载的也是同一个组件，
            // 那次挂载决定了初始面板，之后再传就晚了
            return (
                <EditorPage
                    notice="正在打开工程…"
                    onHome={home}
                    initialTab={initialTab}
                />
            );
        case 'failed':
            return (
                <EditorPage
                    notice={`打开失败：${state.message}`}
                    onHome={home}
                />
            );
        case 'unavailable':
            return <EditorPage notice="工程只能在桌面端打开" onHome={home} />;
        default:
            // 没带 id：设计稿预览，用示例工程
            return <EditorPage onHome={home} />;
    }
}

/**
 * 创作进行页。文稿与音色靠路由 state 带过来。
 *
 * 直接敲地址进来（或刷新）时那份 state 是空的——**此时不能凭空跑一次创作**，
 * 回创作页重新填。桌面端没有地址栏，这一步只会发生在开发时。
 *
 * 唯一的例外是**没有桥**的环境（`pnpm ui:shot` 的离屏浏览器）：那里根本发不起
 * 创作，却需要把这一页画出来和设计稿比对。所以那种情况下用一段示例文稿兜底。
 * 真机上永远有桥，走不到这个分支。
 */
const SHOT_SCRIPT =
    '那我给你的这些素材里面呢，主要是结合了一些片段啊，就是说前端的演讲，' +
    '然后呢到智能体开发的一些演进。我现在需要你帮我制作一个混剪视频，' +
    '收集这些素材，帮我做一个前端转型 AI Agent 的开发学习路径，以及接下来的准备。';

function CreatingRoute() {
    const navigate = useNavigate();
    const state = useLocation().state as Partial<CreatingHandoff> | null;
    const script = state?.script ?? (hasBridge() ? '' : SHOT_SCRIPT);

    if (script.trim() === '') {
        return <Navigate to="/workspace" replace />;
    }

    return (
        <div className="flex h-full w-full bg-pj-bg font-ed">
            <CreatingPage
                handoff={
                    state?.voiceId === undefined
                        ? { script }
                        : { script, voiceId: state.voiceId }
                }
                onBack={() => navigate('/workspace')}
                // 跑完直接进编辑器，并停在「口播」那一栏
                onDone={(dirName) =>
                    navigate(
                        dirName === '' ? '/workspace' : `/editor/${dirName}`,
                        { state: { justCreated: true } }
                    )
                }
            />
        </div>
    );
}

// 每条路由都挂同一个兜底页：渲染期抛错时顶掉 React Router 的开发态错误屏
const withErrorBoundary = (route: RouteObject): RouteObject => ({
    ...route,
    errorElement: <RouteError />
});

export const routes: RouteObject[] = [
    {
        path: '/',
        element: <WorkspaceLayout />
    },
    {
        path: '/editor',
        element: <EditorRoute />
    },
    {
        path: '/editor/:projectId',
        element: <EditorRoute />
    },
    {
        // 项目与创作合在这一条路由里，靠左侧胶囊导航 tab 切换。
        // 不拆成两条路由：切路由会让侧栏连同两团 blur 光晕重新挂载，视觉上闪一下。
        path: '/workspace',
        element: <WorkspaceLayout />
    },
    {
        // 点「创建」之后进这一页。单开一条路由而不是在创作页底下展开：
        // 跑起来之后文稿已经发出去了，还让它留在可编辑的输入框里只会误导人
        path: '/creating',
        element: <CreatingRoute />
    },
    {
        // 兜底：匹配不上的 hash 一律回首屏，而不是掉进 React Router 的错误屏。
        // 典型场景是路由改过名之后，窗口里还留着旧 hash（比如已删掉的 #/projects），
        // 桌面端没有地址栏，用户在那一屏是走不出去的。
        path: '*',
        element: <Navigate to="/" replace />
    }
].map(withErrorBoundary);

// Electron 打包后以 file:// 加载页面，使用 hash 路由避免刷新丢失路由
export const router = createHashRouter(routes);
