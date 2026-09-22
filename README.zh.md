# dsh-plugin-preflight

[English](README.md) | 中文

在你把插件提交到[社区精选列表](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) **之前**做一次自检——
发布之前也适用。

```sh
npx dsh-plugin-preflight              # 检查当前目录
npx dsh-plugin-preflight path/to/repo # 检查别处的仓库
npx dsh-plugin-preflight --strict     # 连警告一起拦截，给 CI 用
```

没有任何东西会阻碍投稿时退出码为 `0`，有则退出码 `1`，可以直接接进工作流。

## 它检查什么

精选列表自己的[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)就是规范。
下表是其中**机器可以验证**的部分：

| 规则 | 为什么重要 |
|---|---|
| `bundle/missing` | 只声明 `dsh.client` 是**投稿被拒最常见的原因**——`dsh.bundle` 才是让插件可安装的东西 |
| `bundle/patch-missing` | `dsh.bundle.patch` 指向的文件不存在 |
| `patch/no-name`、`patch/name-mismatch` | 补丁层没有插入任何条目，或插入的条目名不是这个包——那就什么都挂载不上 |
| `patch/id-missing` | 没有稳定 `id` 的条目无法被后续补丁层定位改写 |
| `client/export-missing`、`client/bundle-missing` | 声明了 `dsh.client` 却没有 `./client` 导出——客户端模块系统会直接抛错 |
| `client/loader-missing`、`client/id-mismatch` | 客户端 bundle 必须是 lazy-CJS 工厂，以包自身的名字注册 `window.__ModuleLoader__.load({ id, factory })` |
| `client/external-self` | 条目在 `dsh.client.external` 里列了自己的包，会让组合阶段抛错 |
| `deps/host-packages` | `@deepseek-ai/*` 的服务应放在 `peerDependencies`，不是 `dependencies` |
| `peer/prerelease-tuple` | 版本范围匹配不上你实际安装的 harness——详见下文 |
| `peer/wildcard` | 裸 `*` 匹配不了任何预发布版 |
| `files/bin-uncovered` | CLI 不在 `files[]` 里，发布出去的包里就没有它 |
| `manifest/*`、`description/*`、`metadata/*` | 带 BOM 或无法解析的清单、营销话术、无法核实的数字、缺 `repository.url` |

## 预发布陷阱

这是这个工具存在的理由，而且它并不直观。

DeepSeek Harness 发布的是**预发布**版本（`0.1.5-rc.2`）。node-semver 只有在**范围里某个比较符正好落在该版本的
`major.minor.patch` 元组上、且自身带预发布标签**时，才放行预发布版本。于是看起来足够宽的范围，会静默排除掉
用户实际在跑的 harness：

```
"*"                      匹配不了 0.1.5-rc.2
">=0.1.0-rc.1"           匹配不了 0.1.5-rc.2
"^0.1.0-rc.6"            匹配不了 0.1.5-rc.2
"^0.1.5-rc.1"            匹配
">=0.1.5-rc.1 <0.2.0-0"  匹配
```

这个错误会在之后以 `ERESOLVE` 的形式冒出来，由你的用户自己去绕。

**在 dsh profile 里运行**，它会解析出该处安装的 harness 版本，并明确告诉你范围是否覆盖它：

```
x [peer/prerelease-tuple] peer "@deepseek-ai/dsh-tools": "^0.2.0" 不匹配已安装的
  @deepseek-ai/dsh-tools@0.1.5-rc.2
    fix: 例如 ">=0.1.5-0 <0.2.0-0"
```

### 它刻意不下判断的地方

不在 profile 里时，没有任何版本可供比对，**工具选择沉默而不是猜测**。这份克制是特性而非缺陷：早期三次
推断目标版本的尝试，每一次都把正确的清单报成坏的——用范围自身元组的 `-rc.1` 去探测，会落在 `^0.1.5-rc.2`
下界**之下**；用 registry 里最新的预发布版去探测，会落在刻意停在它之前的范围**之上**；而把只发稳定版的包
按预发布规则判定，会让 `cordis` 上的 `^4.0.1` 被误报。**一个为了显得勤勉而编造发现的 linter，
比一个承认自己看不到什么的 linter 更糟。**

在没有已安装 harness 时唯一会给出的判断是 `peer/wildcard`：裸 `*` 在任何元组上都没有带预发布标签的比较符，
所以对所有预发布版都不成立，npm 自己就会拒绝。

## 对真实目录的实测

从线上精选目录里抽取 400 个已发布到 npm 的插件：

```
声明 @deepseek-ai/dsh-* peer 的插件 : 194
  裸通配符 "*"                      :  21   (10.8%)   <- 确凿错误
  保持沉默（不下判断）               : 173
```

`dsh-market` 是这个生态里安装量最大的插件，它没有任何 findings——它那套四分支的 peer 范围是正确的。

## 作为 DSH 插件安装

```sh
dsh plugin --profile web add dsh-plugin-preflight
```

它会注册一个只读的、面向模型的工具，让正在搭建插件的 agent 能检查自己的产出：

```
plugin_preflight(dir)
```

**刻意没有浏览器半侧、没有设置页面**——这是一个开发者诊断工具，给它配个面板只会变成 UI 噪音。

## 本地部署（以及那个会让你丢掉界面的陷阱）

从 npm、GitHub spec 或 tarball 安装都正常工作：

```sh
dsh plugin --profile web add dsh-plugin-preflight
```

但用**本地路径**安装是另一回事，动手前值得先知道：

```sh
dsh plugin --profile web add /path/to/this/checkout   # 创建的是 junction，不是拷贝
```

pnpm 会链接这个目录，而 Node 解析 ESM 导入时走的是符号链接的**真实路径**。于是 Loader 从该目录
导入插件时，会沿那棵树向上找 `node_modules`——`D:\node_modules`、`C:\node_modules`——永远走不到
harness 自己的包。**在模块顶层导入宿主包的插件因此加载失败，而 Loader 会中止整棵插件树：
DeepSeek Harness 起不来，你本来用来撤销它的那个界面也没了。**

本插件刻意避开了这个结果：它的宿主半侧**惰性导入**工具运行时，因此运行时不可达时它会以
「仅 CLI」的形态继续挂载，而不是把整个 harness 拖下水。反正 CLI 从来不需要那个运行时——
真正干活的本来就是它。

这个解析失败是**结构性的，不是可以绕过的 bug**：pnpm 刻意不安装 peer 依赖，因为
`@deepseek-ai/dsh-tools` 多一份拷贝就等于框架有了两个实例。链接安装看不到宿主那份，于是降级。

**实际后果：从本地仓库安装，你只得到 CLI。** `plugin_preflight` 工具会静默缺席，因为注册它
需要链接安装解析不到的那个运行时。这个结果是正确的，但值得事先知道，而不是事后才发现。

**如果你在本地开发这个插件**，想要工具生效就装打包好的产物，而不是仓库目录：

```sh
npm pack
dsh plugin --profile web add ./dsh-plugin-preflight-0.1.0.tgz
```

如果你在**别的**插件上撞到启动失败的问题，恢复办法是把出问题的条目从
`$DSH_HOME/profiles/<name>/package.json` 里删掉（`dependencies` 与 `dsh.profile.bundles` 两处），
然后重新开始。

## 局限

- 只做结构性检查。它无法判断插件是否名副其实——那需要维护者去读仓库，而数清描述里的"46 个工具"仍然是人的活。
- 不检查仓库年龄（列表要求满 1 天）与 `dsh-plugin` GitHub topic。两者都需要 GitHub API，
  不值得为此让一个你每次提交都要跑的检查依赖网络。
- 不做依赖树完整性检查。`node_modules` 布局损坏是另一类故障，有它自己的工具。

## License

MIT
