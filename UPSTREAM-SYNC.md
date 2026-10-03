# ZCode 上游同步策略

本仓库（Cotaya）是构建在 [zai-org/ZCode](https://github.com/zai-org/ZCode) 之上的长期商业 fork/产品。ZCode 按**上游供应商项目**对待，不是可以随意改写的自有代码。

首要工程目标：

> 让本 fork 与上游 ZCode 保持在合理范围内的低 diff，使上游的改进、bug 修复和安全更新能够长期持续合入。

## Git 分支模型

```text
zai-org/ZCode
      │
      ▼
upstream/main
      │
      ▼
vendor/zcode
      │
      │ merge
      ▼
main
      │
      ├── feature/*
      ├── fix/*
      └── refactor/*
```

### `upstream/main`

`upstream` 指向官方 ZCode 仓库：

```bash
git remote add upstream https://github.com/zai-org/ZCode.git
```

不要在 upstream 跟踪分支上直接提交产品特定改动。

### `vendor/zcode`

`vendor/zcode` 是官方 ZCode 的干净跟踪分支，应尽量贴近 `upstream/main`。更新方式：

```bash
git fetch upstream
git switch vendor/zcode
git merge --ff-only upstream/main
```

不要在 `vendor/zcode` 上放产品特定提交。

### `main`

`main` 是产品权威分支。周期性上游同步通过把 `vendor/zcode` merge 进 `main` 完成：

```bash
git switch main
git merge vendor/zcode
```

冲突在这里解决。这样使上游集成显式化并保留 merge 谱系，让 Git 记住历史上已解决过的冲突。

## Merge 与 Rebase 规则

### 上游同步

长期产品分支使用：

```text
merge upstream/vendor history into main
```

**不要**对长期产品分支例行执行：

```bash
git rebase upstream/main
```

不要为了让历史显得线性而重写已共享的产品历史。对改动深重的 fork 长期 rebase，会把所有产品提交反复重放到新的上游历史上，导致旧冲突不断重现、协作变难。

### Feature 分支

短期、私有或本地的 feature 分支可以 rebase：

```bash
git fetch origin
git rebase origin/main
```

总则：

```text
Upstream → 产品 main：merge

产品 main → 本地 feature 分支：允许 rebase
```

除非明确指示，绝不 force-push 重写过的共享分支历史。

## 低 diff fork 原则

最重要的规则不是 Git 语法，而是**最小化对上游拥有文件的修改**。同步成本大致按以下乘积增长：

```text
被修改的上游文件数
×
上游变更频率
×
侵入程度
```

### 优先扩展，其次修改

可行时优先：

- 新增模块，而不是修改上游内部实现；
- 新增 adapter，而不是替换上游行为；
- 新增 hook 或接口，而不是复制整个子系统；
- 包装上游功能，而不是 fork 其实现；
- 把产品特有的服务、路由、鉴权、计费、品牌、编排和商业逻辑隔离在上游模块之外。

推荐结构：

```text
upstream code
     │
     ▼
small integration hook
     │
     ▼
our product module
```

避免结构：

```text
upstream subsystem
     ↓
large copied and modified subsystem
     ↓
independent fork that can no longer absorb upstream changes
```

## 最小化上游补丁

如果无法避免修改上游代码，补丁必须：

- 小；
- 局部；
- 易理解；
- 易移除；
- 易重贴；
- 与无关产品逻辑分离。

能用集中抽象引入的行为，就不要把它摊到几百个上游文件里。

修改上游文件前，先问：

1. 能否实现为新模块？
2. 能否引入 hook 或 adapter？
3. 集成点能否更小？
4. 产品逻辑能否留在这个上游文件之外？
5. 这次修改会不会让下一次上游 merge 不必要地更难？

## 当前状态

- 2026-10-03 完成初始化：`upstream` remote、`vendor/zcode`（跟踪 `upstream/main`）已建立。
- 初始化时 `main`、`vendor/zcode`、`upstream/main` 三者同点于 `29628c9`（上游标签 `v3.14.3`），fork 尚未分叉——此后每一次对上游文件的修改都会成为长期同步成本，动手前先过上面的自检清单。
- `vendor/zcode` 目前仅存在于本地；如需团队共享，可推送到 origin（`git push origin vendor/zcode`）。
