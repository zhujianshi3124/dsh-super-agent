# dsh-super-agent

> **关于本仓库 / About this repository**
>
> 本仓库基于 DeepSeek Harness 团队以 MIT 协议开源的 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 修改而来，由个人维护，与 DeepSeek 官方无关，也不是官方产品。上游的版权声明保留在 [LICENSE](LICENSE) 里。
>
> This is an independently maintained, modified version of [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), which the DeepSeek Harness Team released under the MIT License. It is not affiliated with or endorsed by DeepSeek. The upstream copyright notice is kept in [LICENSE](LICENSE).

## 相对上游的主要改动 / Changes from upstream

- 主会话（chief）来源：在自己开的主会话里直接交代任务，确认后变成工单。
- 指令清单（proposal）：先起草任务和完成标准，用户确认后才派工单。
- 工头（foreman）会话：拆单、派单、调度；上下文到阈值或卡住时换代交接。
- 收工 / 开工、卡住判定、半路停下的工单续跑、工头回合被打断时自动重投。
- 上下文守卫扩展 `extensions/context-guard`，以及 Windows 下的开关、守护、卸载脚本 `scripts/superagent-*.ps1`。
- 默认目录按 Windows 设定：主会话 `D:\chief`（部署设置可改），工头固定 `D:\gongtou`，工人默认 `D:\buzhiding`（执行设置可改）。

In short: a main-Session (chief) Source, confirmed instruction lists, a rotating foreman Session, wrap-up / resume, stuck handling, a context-guard extension and Windows helper scripts. Default directories are Windows paths (see above).

以下是上游 README 原文，安装和文档部分同样适用于本仓库。 / The rest of this README is the upstream text.

---

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
