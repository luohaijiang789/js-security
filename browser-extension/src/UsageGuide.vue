<script setup lang="ts">
import Icon from "./Icon.vue";

const fields = [
  ["直接写文字", "请求完整 URL 包含文字", "orders"],
  ["url", "请求完整 URL 包含值", "url:/api/orders"],
  ["domain", "请求域名等于该域名或是其子域名", "domain:example.com"],
  ["path", "URL pathname 包含值，不含 query", "path:/api/orders"],
  ["method", "HTTP 方法完全匹配", "method:GET,POST,PUT"],
  ["status-code", "终态 HTTP 状态码完全匹配", "status-code:200,201,204"],
  [
    "resource-type",
    "Chrome 返回的资源类型完全匹配",
    "resource-type:XHR,Fetch,Ping",
  ],
  ["extension", "URL 路径最后一段的扩展名", "extension:js,css,png"],
  ["page", "发出请求的页面完整 URL 包含值", "page:console.example.com/orders"],
  ["page-domain", "页面域名等于该域名或是其子域名", "page-domain:example.com"],
  ["referer", "HTTP Referer 请求头包含值", "referer:/console/"],
  ["initiator", "发起脚本 URL 包含值", "initiator:app.js"],
  ["query.参数名", "指定 Query 参数的任一值包含内容", "query.orderId:12345"],
  [
    "header.请求头名",
    "指定请求头的任一值包含内容；名称不区分大小写",
    "header.Authorization:Bearer",
  ],
  [
    "body.JSON路径",
    "JSON 点路径或表单字段的值包含内容",
    "body.customer.id:C1001",
  ],
];

const resourceTypes = [
  ["XHR", "XMLHttpRequest 发起的请求", "接口请求"],
  ["Fetch", "fetch() 发起的请求", "接口请求"],
  ["Ping", "navigator.sendBeacon()、ping 等", "埋点、Beacon"],
  ["Preflight", "浏览器自动发送的 CORS OPTIONS 预检", "跨域预检"],
  ["Document", "主文档、iframe 文档和页面导航", "HTML 页面"],
  ["Script", "JavaScript 脚本", "js、mjs"],
  ["Stylesheet", "CSS 样式表", "css"],
  ["Image", "图片资源", "png、jpg、svg、webp 等"],
  ["Media", "音频和视频资源", "mp3、mp4 等"],
  ["Font", "网页字体", "woff、woff2、ttf 等"],
  ["TextTrack", "视频字幕或文本轨道", "vtt 等"],
  ["EventSource", "EventSource / Server-Sent Events", "SSE"],
  [
    "WebSocket",
    "Chrome 报告为资源请求的 WebSocket 握手",
    "覆盖受 CDP 事件限制",
  ],
  ["Manifest", "Web App Manifest", "manifest.json"],
  ["Prefetch", "prefetch 等预取资源", "浏览器预加载"],
  ["SignedExchange", "Signed HTTP Exchange", "sxg"],
  ["CSPViolationReport", "CSP 违规报告", "浏览器安全报告"],
  ["FedCM", "Federated Credential Management 请求", "联合身份"],
  ["Other", "Chrome 未归入以上类型的请求", "兜底类型"],
];

const syntax = [
  ["空框", "保存全部可观测请求", ""],
  ["英文分号 ;", "并且；每个条件都要满足", "domain:example.com; method:POST"],
  ["英文逗号 ,", "同一字段任选一个", "method:GET,POST"],
  ["前缀 -", "排除匹配项", "-resource-type:Image,Font"],
  ["大写 OR", "两个完整条件任选一个", "(method:POST OR method:PUT)"],
  [
    "圆括号 ()",
    "明确 OR/AND 的组合范围",
    "domain:a.com; (method:GET OR method:POST)",
  ],
  ["双引号", "值中包含空格或英文分号", 'url:"order detail"'],
  ["/表达式/", "区分大小写的 JavaScript 正则", "url:/\\/api\\/v\\d+/"],
  ["/表达式/i", "忽略大小写的 JavaScript 正则", "url:/\\/API\\//i"],
  ["字段:?", "字段存在，即使值是空字符串", "header.Authorization:?"],
  ["-字段:?", "字段不存在", "-query.debug:?"],
];

const examples = [
  ["只保留接口请求", "resource-type:XHR,Fetch,Ping"],
  ["排除常见静态资源", "-resource-type:Image,Media,Font,Stylesheet,Script"],
  [
    "只看某业务页面发出的接口",
    "page-domain:example.com; resource-type:XHR,Fetch,Ping",
  ],
  ["只看 POST/PUT 的 API", "url:/\\/api\\//i; method:POST,PUT"],
  ["只看 4xx/5xx", "status-code:/^[45]\\d\\d$/"],
  ["查 GraphQL 请求", "path:/graphql; method:POST"],
  ["查带认证头的请求", "header.Authorization:?"],
  ["查指定 Query 参数", "query.orderId:12345"],
  ["查 JSON 正文路径", "body.customer.id:C1001"],
  ["排除健康检查", "-url:/\\/health(?:check)?/i"],
  [
    "阿里云页面发出的接口",
    "page-domain:aliyun.com; resource-type:XHR,Fetch,Ping",
  ],
];
</script>

<template>
  <section class="settings-layout guide usage-manual">
    <div class="panel usage-intro">
      <div class="panel-heading">
        <div>
          <span class="eyebrow">USER GUIDE</span>
          <h2>完整使用说明</h2>
          <p>从创建任务、编写过滤条件，到查看和导出结果，都可以按本页操作。</p>
        </div>
        <span class="metric-icon blue"><Icon name="help" :size="20" /></span>
      </div>
      <ol class="usage-steps">
        <li>
          <strong>新建任务</strong
          ><span
            >选择字段值保存方式、归并方式和需要保存的字段；默认保存字段全部勾选。</span
          >
        </li>
        <li>
          <strong>填写过滤条件</strong
          ><span
            >空框保存全部请求；多个条件用英文分号 <code>;</code> 连接。</span
          >
        </li>
        <li>
          <strong>执行业务操作</strong
          ><span>当前和新打开的普通网页会自动接入，不需要选择标签页。</span>
        </li>
        <li>
          <strong>检查请求详情</strong
          ><span
            >点击列表行查看参数、请求头、正文、Request call stack
            和发起链。</span
          >
        </li>
        <li>
          <strong>停止并导出</strong
          ><span
            >正式交接前先停止任务，再导出 JSONL、CSV、ZIP 或分片目录。</span
          >
        </li>
      </ol>
    </div>

    <div class="panel usage-highlight">
      <h2><code>resource-type</code> 后面到底填什么</h2>
      <p>
        它匹配 Chrome DevTools Protocol
        返回的资源类型，采用<strong>完全匹配</strong>，普通文字匹配不区分大小写。它不是文件后缀，也不是
        Content-Type。 接口请求最常用的是 <code>XHR</code>、<code>Fetch</code>
        和 <code>Ping</code>。
      </p>
      <div class="usage-callout">
        <strong>推荐直接复制：</strong>
        <code>resource-type:XHR,Fetch,Ping</code>
        <span>只保留常见接口、fetch 和 Beacon 请求。</span>
      </div>
      <div class="usage-callout">
        <strong>排除静态资源：</strong>
        <code>-resource-type:Image,Media,Font,Stylesheet,Script</code>
      </div>
      <p class="field-note">
        不要填写 <code>API</code>、<code>JSON</code> 或
        <code>Beacon</code>：Chrome 没有这些 resource type。JSON 接口通常是
        <code>XHR</code> 或 <code>Fetch</code>；<code
          >navigator.sendBeacon()</code
        >
        通常是
        <code>Ping</code
        >。浏览器版本新增的类型仍会原样记录，可先在请求列表的“类型”列确认实际值。
      </p>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>可填写值</th>
              <th>Chrome 含义</th>
              <th>常见场景</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in resourceTypes" :key="row[0]">
              <td>
                <code>{{ row[0] }}</code>
              </td>
              <td>{{ row[1] }}</td>
              <td>{{ row[2] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h2>过滤语法：符号如何组合</h2>
      <p class="field-note">
        字段名和普通文字值默认不区分大小写；只有不带
        <code>i</code> 的正则区分大小写。请使用英文符号。
      </p>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>写法</th>
              <th>含义</th>
              <th>可复制示例</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in syntax" :key="row[0]">
              <td>
                <code>{{ row[0] }}</code>
              </td>
              <td>{{ row[1] }}</td>
              <td>
                <code v-if="row[2]">{{ row[2] }}</code
                ><span v-else>留空</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="usage-notes">
        <p>
          <strong>分号和逗号不同：</strong
          ><code>method:POST; status-code:200</code> 表示两个条件同时满足；<code
            >method:GET,POST</code
          >
          表示 GET 或 POST。
        </p>
        <p>
          <strong>排除多个值：</strong
          ><code>-resource-type:Image,Script</code> 表示 Image 或 Script
          都不要保存。
        </p>
        <p>
          <strong>值中有逗号：</strong
          >逗号会被当成“任选一个”，需要匹配真实逗号时请用正则，例如
          <code>url:/a,b/</code>。
        </p>
        <p>
          <strong>生效时间：</strong
          >应用到当前任务后只影响之后收到的请求，已经保存的记录不会被重新筛选。
        </p>
      </div>
    </div>

    <div class="panel">
      <h2>全部可用过滤字段</h2>
      <div class="usage-table-wrap">
        <table class="usage-table field-reference">
          <thead>
            <tr>
              <th>字段</th>
              <th>匹配的数据与规则</th>
              <th>可复制示例</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in fields" :key="row[0]">
              <td>
                <code>{{ row[0] }}</code>
              </td>
              <td>{{ row[1] }}</td>
              <td>
                <code>{{ row[2] }}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="usage-notes">
        <p>
          <strong><code>page</code> 和 <code>url</code>：</strong
          ><code>page</code> 是哪个网页发出了请求；<code>url</code>
          是请求发往哪里。例如控制台页面调用 API 时，两者通常不同。
        </p>
        <p>
          <strong><code>referer</code> 和 <code>page</code>：</strong>Referer
          是浏览器实际提供的 HTTP 请求头，可能缺失；page 来自 CDP
          的页面归属信息。
        </p>
        <p>
          <strong>Header 名称：</strong>不区分大小写，<code
            >header.authorization</code
          >
          与 <code>header.Authorization</code> 等效。
        </p>
        <p>
          <strong>Query 和 Body 名称：</strong>区分大小写；页面发送的是
          <code>orderId</code> 时，请照原样写
          <code>query.orderId</code>，不要改成 <code>query.orderid</code>。
        </p>
        <p>
          <strong>Body 路径：</strong><code>body.customer.id</code> 查 JSON 的
          <code>customer.id</code>；对于表单，点号后填写表单字段名。
        </p>
        <p>
          <strong>扩展名：</strong>只填后缀本身，不带点，例如
          <code>extension:js,png</code>，不要写 <code>extension:.js</code>。
        </p>
        <p>
          <strong>状态码：</strong><code>status-code</code>
          只有收到响应后才确定；请求进行中时会暂时显示无法判定，完成后自动更新。
        </p>
        <p>
          <strong>未知值：</strong
          >状态码、请求头、正文或页面信息尚未取得时，结果可能显示“无法判定”；默认会保留并标注，不会静默丢弃。
        </p>
      </div>
    </div>

    <div class="panel">
      <h2>常用场景，复制后直接修改</h2>
      <div class="usage-examples">
        <div v-for="row in examples" :key="row[0]">
          <strong>{{ row[0] }}</strong
          ><code>{{ row[1] }}</code>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>字段保存、详情与导出</h2>
      <div class="usage-notes">
        <p>
          <strong>保存字段：</strong
          >请求头、Query、请求体、响应头、响应体、响应元数据、页面来源、发起信息/关系链、调用栈默认全选。基础身份字段始终保存。Filter
          先使用完整观测数据判断，再移除未勾选字段。
        </p>
        <p>
          <strong>响应头：</strong>保存 Chrome 可观测的
          Content-Type、Set-Cookie、CORS、CSP、缓存等响应头；Chrome
          提供原始头文本时也会写入原始数据，重复头不会只靠界面表格判断。
        </p>
        <p>
          <strong>响应体：</strong>请求完成后通过 CDP 读取。JSON
          会解析，文本保留原文，图片等二进制以 Base64
          保存。失败、被取消、重定向跳次、浏览器已清理缓存或特殊协议响应可能无法取得，原因会写入采集状态。
        </p>
        <p>
          <strong>响应元数据：</strong>保存 MIME、HTTP 协议、远端
          IP/端口、磁盘缓存、Service Worker、预取缓存、传输字节数、Timing、TLS
          安全信息及可观测的 Cookie 阻止原因。
        </p>
        <p>
          <strong>字段值：</strong
          >“完整保留”不截断请求和响应值；“自动截断”保持字段名完整，只裁剪超长值及正文并保留首尾和原始长度。响应体通常最大，快速分析时建议使用自动截断。两种模式都不按
          Cookie、Token 等名称脱敏。
        </p>
        <p>
          <strong>调用栈：</strong>Request call stack 只展示 Chrome
          实际返回的同步帧和异步父链；缺失或截断会写明原因。
        </p>
        <p>
          <strong>导出：</strong>JSONL 保留完整结构，CSV 便于表格分析，ZIP
          适合小任务，大任务使用分片目录。采集中导出属于实时快照，正式交接前应先停止任务。
        </p>
      </div>
    </div>

    <div class="panel usage-highlight">
      <h2>自动保存到阿里云 SLS</h2>
      <p>
        打开左侧“存储与转存”，在“自动保存到阿里云
        SLS”中配置。启用后会把当前任务中尚未转存的已保存记录和之后的新记录持续写入
        Logstore；本地数据不会因为 SLS 成功或失败而删除。
      </p>
      <ol class="usage-troubleshooting">
        <li>
          在阿里云日志服务创建 Project 和 Logstore，并确认使用公网 Endpoint
          或浏览器能够访问的自定义 HTTPS 域名。
        </li>
        <li>
          推荐选择“STS 临时凭证签名”。为临时身份只授予目标 Logstore 的
          <code>log:PostLogStoreLogs</code> 写入权限，并设置尽量短的有效期。
        </li>
        <li>
          Endpoint 填地域地址，例如
          <code>cn-hangzhou.log.aliyuncs.com</code>，不要带 Project；Project 和
          Logstore 分别填写控制台中的实际名称。自定义域名填写完整
          <code>https://logs.example.com</code>，不能带路径、Query 或凭据。
        </li>
        <li>
          填入 STS AccessKey ID、AccessKey Secret 和 SecurityToken，点击“授权
          SLS
          并保存会话凭证”，再点击“保存全部转存策略”。凭证只存在当前浏览器会话，不写入任务、IndexedDB
          或导出文件；浏览器重启或凭证过期后需要重新填写。
        </li>
        <li>
          可点击“立即归档 /
          转存”马上发送；否则按发送间隔自动形成批次。在“批次进度”查看完成、失败、重试次数和
          SLS Request ID。
        </li>
      </ol>
      <div class="usage-callout">
        <strong>RAM 最小权限：</strong>
        <code>Action: log:PostLogStoreLogs</code>
        <span
          >Resource 只限定到实际 Project /
          Logstore；不要给浏览器长期主账号密钥。</span
        >
      </div>
      <div class="usage-notes">
        <p>
          <strong>SLS 日志内容：</strong>每条日志直接提供
          <code>method</code
          >、<code>request_url</code>、<code>domain</code>、<code>status_code</code>、<code>resource_type</code>、<code>scan_id</code>、<code
            >request_id</code
          >
          等检索字段；完整记录放在 <code>record_json_chunk</code>。
        </p>
        <p>
          <strong>建立索引：</strong>首次写入后，在 SLS 为
          <code>request_url</code
          >、<code>domain</code>、<code>method</code>、<code>status_code</code>、<code>resource_type</code>、<code>scan_id</code>、<code>request_id</code>、<code
            >transfer_batch_id</code
          >
          建立字段索引；否则数据已经写入也不便按字段检索。
        </p>
        <p>
          <strong>超大记录还原：</strong>按相同
          <code>record_sha256</code> 汇总，依照
          <code>record_chunk_index</code> 从 1 到
          <code>record_chunk_total</code> 拼接
          <code>record_json_chunk</code>，即可恢复原 JSON。
        </p>
        <p>
          <strong>重复处理：</strong>SLS
          属于至少一次投递。响应丢失后重试可能产生重复日志，可用
          <code>transfer_batch_id + request_id + record_chunk_index</code>
          去重；分批请求由
          <code>transfer_part_index / transfer_part_total</code> 标识。
        </p>
        <p>
          <strong>WebTracking：</strong>该模式不需要凭证，但必须在 Logstore
          开启公网匿名写入，任何人都可能写入脏数据。只有明确接受这个风险时才选择。
        </p>
        <p>
          <strong>失败与重试：</strong>网络错误、权限错误、STS 过期和 SLS 非 2xx
          响应都会保留失败批次及错误信息；自动最多尝试 3
          次，之后可在界面重新授权并点击“重试失败批次”。部分分片已成功但回执丢失时，重试仍可能重复，因此必须按上述键去重。
        </p>
      </div>
    </div>

    <div class="panel">
      <h2>没有采集到预期请求时</h2>
      <ol class="usage-troubleshooting">
        <li>先把过滤框清空，确认请求是否出现在完整列表中。</li>
        <li>
          查看列表“类型”列，再把实际类型填写到
          <code>resource-type:</code> 后面。
        </li>
        <li>
          确认用了英文分号 <code>;</code>、英文逗号 <code>,</code> 和英文冒号
          <code>:</code>。
        </li>
        <li>检查是否误用了 <code>-</code>；前缀减号代表排除。</li>
        <li>页面刚打开时可能早于调试连接，刷新业务页面重新触发一次。</li>
        <li>若条件依赖状态码、Header 或 Body，等待请求完成后再看最终判断。</li>
        <li>
          若详情缺少字段，检查任务的“保存字段”是否取消勾选，并查看字段旁的采集状态。
        </li>
        <li>
          响应体只能在请求成功结束后读取；失败或长连接未结束时，先查看响应头和响应元数据。
        </li>
      </ol>
    </div>
  </section>
</template>
