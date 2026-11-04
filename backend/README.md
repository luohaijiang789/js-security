# 统一采集分析后端

接收唯一生产插件[browser-extension](../browser-extension/README.md)分类发送的API实测、JS正文、页面/执行上下文和加载证据，负责存储、去重、关联、静态提取、Agent作业及结果导出。

## 实际能力

| 能力 | 现在能做什么 |
| --- | --- |
| 接收 | capture-stream-2分类事件、分块、服务端SHA-256、持久ACK、事件幂等与查询 |
| 归一化与提取 | 显式离线ingest读取已接收证据，复用资产图与固定jshound，输出API清单和实测/静态关联 |
| 尚未完成 | 自动调度、水位/增量重分析、精确发送点/调用变体、Agent、Excel、统一插件结果回传及真实MV3现场 |

Python包名`website_js_extractor`和现有console命令保留兼容，工程目录已由`website-js-extractor/`迁到`backend/`。旧独立插件移到[legacy](../legacy/README.md)。旧/v0只作原型兼容，不作为生产远端入口。

## 启动与分析

在仓库根目录，Python 3.10+直接启动，无额外Python依赖：

```bash
python3 backend/server.py
```

默认`0.0.0.0:8379`、`backend/data/capture/`；插件只填`http://服务器IP:8379`，支持HTTP/HTTPS源地址。`--host`、`--port`、`--data-dir`可覆盖配置。`curl http://127.0.0.1:8379/health`检查接收服务；健康不表示已运行分析。固定code/default项目内置，无需手填扩展ID、项目或令牌，code不是秘密凭证。

静态分析需要Node.js与固定jshound子模块：

```bash
git submodule update --init references/repos/jshound
PYTHONPATH=backend/src python3 -m website_js_extractor.cli ingest \
  --data-dir backend/data/capture --out work/ingest/run-1
```

用`--scan`指定任务，不指定时取最近活动任务。输出`analysis.json`、`api_inventory.json/csv`、`observed_requests.json/csv`及资产/参数/引用/缺口表；目录必须新建或为空。当前静态结果仍是文件级候选，不是精确调用点。默认不联网、不执行JS、不调用提取API。

## 工程入口

| 文档 | 职责 |
| --- | --- |
| [需求](docs/requirements.md) | 收什么、用户流程、输出和边界 |
| [架构](docs/architecture.md) | 语言、进程、目录、数据流与当前/目标区分 |
| [模块](docs/modules.md) | 实现路径、输入输出、完成条件、依赖 |
| [Agent](docs/agent.md) | 模型适配、工具、预算和核验，当前未实现 |
| [实际协议](docs/protocol.md) | 当前wire格式与路由、旧输入兼容 |
| [分析算法](docs/analysis-design.md) | 资产图、深度、上下文、提取算法 |
| [计划](docs/plan.md) | 唯一进度与交付顺序 |
| [验收](docs/testing.md) | 自动化、冻结样本、真实MV3和发布 |

运行后端测试：`PYTHONPATH=backend/src python3 -m unittest discover -s backend/tests -p 'test_*.py'`。许可见[第三方说明](THIRD_PARTY_NOTICES.md)。
