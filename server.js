const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer();

const ARK_API_KEY = process.env.ARK_API_KEY;
const MODEL_ID = "doubao-seed-2-0-mini-260428";
const API_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const SPREADSHEET_TOKEN = process.env.SPREADSHEET_TOKEN;
const SHEET_ID = process.env.SHEET_ID;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callAiWithRetry(prompt, retryCount = 2) {
  for (let i = 0; i <= retryCount; i++) {
    const st = Date.now();
    try {
      const aiRes = await axios.post(API_URL, {
        model: MODEL_ID,
        messages: [{ role: "user", content: prompt }],
        temperature: 0
      }, {
        headers: {
          Authorization: `Bearer ${ARK_API_KEY}`,
          "Content-Type": "application/json"
        }
      });
      console.log(`AI耗时 ${((Date.now() - st) / 1000).toFixed(1)}s`);
      return aiRes.data;
    } catch (err) {
      console.log("火山接口报错：", err.response?.data);
      const code = err.response?.data?.error?.code;
      if (code === "ServerOverloaded" && i < retryCount) {
        console.log(`负载高，${(i + 1) * 3}s后重试`);
        await sleep((i + 1) * 3000);
        continue;
      }
      throw err;
    }
  }
}

function safeParseJson(rawText) {
  try {
    const match = rawText.match(/\[.*\]/s);
    let jsonStr = match ? match[0] : rawText;
    jsonStr = jsonStr.replace(/(?<!\\)'/g, '"');
    return JSON.parse(jsonStr);
  } catch (e) {
    console.log("AI原始返回内容：", rawText);
    throw new Error("JSON解析失败，模型返回格式异常");
  }
}

async function getTenantToken() {
  const res = await axios.post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    app_id: FEISHU_APP_ID,
    app_secret: FEISHU_APP_SECRET
  });
  return res.data.tenant_access_token;
}

async function appendToSheet(sheetToken, sheetId, rowData, token) {
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${sheetToken}/values_append`;
  const payload = {
    valueRange: {
      range: `${sheetId}!A1:N1000`,
      values: [rowData]
    }
  };
  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
}

app.post('/api/resume-parse', upload.single('resume'), async (req, res) => {
  const totalStart = Date.now();
  try {
    const fileBuf = req.file.buffer;
    const pdfResult = await pdfParse(fileBuf);
    let text = pdfResult.text;
    text = text.replace(/\s+/g, ' ').trim();

    console.log(`PDF提取文本，共 ${text.length} 字符`);
    const prompt = `
严格只输出一维JSON数组，不要任何解释、markdown、注释。
顺序固定：姓名，性别，出生日期，证件号，最高学历毕业时间，最高学历专业，毕业院校，联系方式，求职意向，教育经历，工作/实习经历，项目经历，荣誉奖励，证书
无信息填""，字符串内部引号自动转义。
简历原文：
${text}
`;
    const aiResData = await callAiWithRetry(prompt);
    const rawContent = aiResData.choices[0].message.content.trim();
    const arr = safeParseJson(rawContent);
    console.log("解析结果：", arr);

    const feishuToken = await getTenantToken();
    await appendToSheet(SPREADSHEET_TOKEN, SHEET_ID, arr, feishuToken);
    res.json({ code: 0, msg: "解析成功，已写入飞书表格", data: arr });
  } catch (err) {
    console.error("整体报错：", err.message);
    res.json({ code: -1, msg: err.message });
  }
});

app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>简历PDF解析收集</title>
<style>
*{box-sizing:border-box;font-family:system-ui}
.box{max-width:750px;margin:40px auto;padding:24px}
#file{margin:16px 0}
button{padding:12px 24px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:16px;margin:4px}
#result{margin-top:24px;padding:20px;background:#f3f4f6;white-space:pre-wrap;min-height:120px;font-size:14px}
</style>
</head>
<body>
<div class="box">
  <h1>简历PDF解析，自动汇总至在线表格</h1>
  <input type="file" id="file" accept=".pdf">
  <br>
  <button onclick="startParse()">开始解析</button>
  <div id="result"></div>
</div>
<script>
async function startParse(){
  const fileInput = document.getElementById('file');
  const resultDom = document.getElementById('result');
  const file = fileInput.files[0];
  if(!file){ resultDom.innerText = "⚠️ 请先选择PDF简历！"; return; }
  resultDom.innerText = "正在解析...";
  const formData = new FormData();
  formData.append('resume', file);
  try{
    const resp = await fetch('/api/resume-parse', { method:"POST", body:formData });
    const json = await resp.json();
    if(json.code === 0){
      resultDom.innerText = "✅ 解析成功，已写入飞书表格：\\n" + JSON.stringify(json.data,null,2);
    }else{
      resultDom.innerText = "❌ 失败：" + json.msg;
    }
  }catch(e){
    resultDom.innerText = "❌ 请求失败：" + e.message;
  }
}
</script>
</body>
</html>
  `;
  res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务启动，端口：${PORT}`);
});
