# dsh-uns-dashboard

UNS 控制台——工业统一命名空间（Unified Namespace）实时监控面板。为 [shine-233/dsh-uns](https://github.com/shine-233/dsh-uns) 插件的适配器提供可视化界面：命名空间树浏览、实时曲线、历史回看与写值。

## 运行

```sh
pnpm install
pnpm start          # http://localhost:8791
```

零构建：原生 ES 模块 + Canvas，无前端框架。默认以 **mock** 模式运行（内置华东示范厂演示数据，1Hz 仿真流），无需任何真实平台即可体验完整交互。

## 数据源

通过环境变量切换，也可在请求上带 `?provider=` 临时切换：

| Provider | 需配置 | 说明 |
|---|---|---|
| `mock`（默认） | 无 | 内置 7 个仿真位号（灌装/包装/空压机），写入会覆盖基线并带缓慢漂移 |
| `supos` | `SUPOS_API_URL`、`SUPOS_API_KEY`，可选 `SUPOS_MQTT_URL` | 复用 dsh-uns 的 SuposAdapter（REST + MQTT watch） |
| `umh` | `UMH_BROKERS`（逗号分隔），可选 `UMH_SCHEMA_REGISTRY` | 复用 UmhAdapter（Kafka 直连，需与 umh-core 同主机） |

`PORT` 可改端口。supos/umh 适配器来自 npm 依赖 `dsh-uns`（github 直装），未配置对应环境变量时相应模式不可用，mock 始终可用。

## 界面

- **命名空间树**：ISA-95 层级（supOS 树遍历 / UMH topic 链重建），支持路径过滤、键盘操作
- **实时曲线**：琥珀磷光风格 Canvas 手绘，最多 3 路同屏，端点脉冲呼吸
- **历史回看**：1时 / 6时 / 24时 快速区间
- **写值**：对话框写入（批量协议单条封装），mock 模式即时生效
- **事件记录**：监视变更、写入、错误流水

动画遵循 `prefers-reduced-motion`；窄屏降级为纵向布局。

## 结构

```
server/index.js   Node 原生 http：静态托管 + REST + SSE 流（复用 dsh-uns 适配器）
server/mock.js    mock provider：仿真位号、历史回填、写入覆盖
public/           前端三件套（无构建）
```
