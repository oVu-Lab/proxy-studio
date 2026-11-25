/**
 * Generates bulletproof, non-destructive browser interceptors (DevTools Console
 * snippet + draggable bookmarklet) for Proxy Studio.
 *
 * Protocols hooked:
 *   - window.fetch (strings, URL, Request clones)
 *   - XMLHttpRequest
 *   - EventSource (SSE GET)
 *   - WebSocket (outgoing & incoming text/JSON frames)
 *
 * Payload encodings supported:
 *   - application/json
 *   - text/plain (raw JSON strings or plain text prompts)
 *   - FormData (multipart/form-data)
 *   - URLSearchParams & application/x-www-form-urlencoded
 *   - Blob / ArrayBuffer / TypedArray text bodies
 *   - GET query parameters
 *
 * Resilience:
 *   - Auto-hooks accessible same-origin <iframe> windows (+ dynamic iframes via MutationObserver)
 *   - Detects cross-origin <iframe>s and prints a clear yellow DevTools Console guide
 *   - Non-over-filtering: ignores static assets & telemetry/analytics/Firestore, captures unknown chat APIs permissively
 *   - Automatic CSP / Mixed-Content / Private-Network fallback saving into window.__proxyCapture.last & .all
 *     with clear copy(__proxyCapture.last) prompt
 *   - Works in both Local auto-callback mode AND Global zero-quota offline/paste mode (callbackUrl = "")
 */

export function buildCaptureCore(
  callbackUrl: string,
  sessionId: string,
  compact = false,
): string {
  const cb = JSON.stringify(callbackUrl || "");
  const sid = JSON.stringify(sessionId || "");

  const code = `(function(){
  var CB=${cb},SID=${sid},HAS_CB=!!CB,HOST=HAS_CB?CB.split("/api/capture/")[0]:"";
  if(window.__proxyCapture&&window.__proxyCapture.stop){try{window.__proxyCapture.stop();}catch(e){}}
  var nativeFetch=window.fetch.bind(window);
  var active=true,sent=0,seen={},restorers=[],hookedSet=[],warnedFrames={},badge=null,mo=null,cspBannerShown=false;
  var ASSET=/\\.(?:m?js|cjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|wasm|mp[34]|wav|ogg|webm|pdf|zip)(?:[?#]|$)/i;
  var NOISE=/(?:firestore\\.googleapis\\.com|firebase(?:installations|logging)?\\.googleapis\\.com|identitytoolkit\\.googleapis\\.com|securetoken\\.googleapis\\.com|firebaseio\\.com|google-analytics\\.com|googletagmanager\\.com|googlesyndication\\.com|googleadservices\\.com|doubleclick\\.net|adservice\\.google|sentry\\.io|ingest\\.sentry|datadoghq\\.com|browser-intake-datadoghq|mixpanel\\.com|segment\\.(?:io|com)|amplitude\\.com|posthog\\.com|hotjar\\.com|clarity\\.ms|plausible\\.io|cloudflareinsights\\.com|intercom\\.io|logrocket\\.com|bugsnag\\.com|rollbar\\.com|launchdarkly\\.com|statsig\\.com|newrelic\\.com|nr-data\\.net|fullstory\\.com|heap\\.io|hcaptcha\\.com|recaptcha\\.net|challenges\\.cloudflare\\.com|documents:commit|documents:batchGet|documents:listen|google\\.firestore|\\/cdn-cgi\\/|\\/gtag\\/|\\/collect(?:\\?|$)|\\/beacon|\\/telemetry|\\/analytics|\\/metrics(?:[/?]|$)|\\/pagead\\/)/i;
  var AD_FRAME=/(?:googlesyndication|doubleclick|googleads|adnxs|recaptcha|hcaptcha|challenges\\.cloudflare|googletagmanager|facebook\\.com\\/plugins|blank$)/i;
  var CHAT_URL=/(?:\\/chat|\\/completions|\\/messages|\\/responses|\\/generate|\\/stream|\\/inference|\\/ask|\\/converse|\\/predict|\\/reply|\\/prompt|\\/ai\\b|\\/llm|\\/bot|\\/assistant|workers\\.dev|generativelanguage\\.googleapis\\.com|openai|anthropic|perchance)/i;
  var CHAT_KEY=/"?(?:messages|prompt|contents|conversation|chat_history|chatHistory|history|input|query|question|message|userMessage|text|content|ask|utterance|instruction|modelId|model_id|model)"?\\s*[:=]/i;
  var CHAT_QUERY=/(?:^|[?&])(?:prompt|message|msg|q|query|input|text|content|ask|chat|instruction)=/i;
  var CHAT_RES=/(?:choices|content_block_delta|reasoning_content|candidates|output_text|"delta"\\s*:|"content"\\s*:|"response"\\s*:|"reply"\\s*:|"answer"\\s*:|"token"\\s*:|"chunk"\\s*:|"text"\\s*:|^data:\\s*\\S|^0:")/im;
  var SSE_CT=/(?:text\\/event-stream|ndjson|jsonl|application\\/stream)/i;
  var API_STORE={last:null,all:[],sessionId:SID,callback:CB,iframes:[],stop:stop,help:help};

  function abs(u,base){try{return new URL(String(u),base||location.href).href;}catch(e){return String(u||"");}}
  function skip(u){
    if(!u)return true;
    if(HAS_CB&&HOST&&u.indexOf(HOST)===0)return true;
    if(!/^(?:https?|wss?):/i.test(u))return true;
    if(ASSET.test(u)||NOISE.test(u))return true;
    return false;
  }
  function hdrObj(h){
    var r={};if(!h)return r;
    try{
      if(typeof h.forEach==="function"){h.forEach(function(v,k){r[String(k)]=String(v);});}
      else if(Array.isArray(h)){for(var i=0;i<h.length;i++)if(h[i]&&h[i].length>=2)r[String(h[i][0])]=String(h[i][1]);}
      else if(typeof h==="object"){Object.keys(h).forEach(function(k){if(h[k]!=null)r[String(k)]=String(h[k]);});}
    }catch(e){}
    return r;
  }
  function getCT(h){
    var ks=Object.keys(h||{});
    for(var i=0;i<ks.length;i++)if(ks[i].toLowerCase()==="content-type")return String(h[ks[i]]||"");
    return "";
  }
  function tryParseJson(s){
    if(typeof s!=="string")return null;
    var t=s.trim();
    if(!t||(t.charAt(0)!=="{"&&t.charAt(0)!=="["))return null;
    try{return JSON.parse(t);}catch(e){return null;}
  }
  function decodeParams(s){
    var o={},sp=new URLSearchParams(s),count=0;
    sp.forEach(function(v,k){
      if(count>=60)return;count++;
      var j=tryParseJson(v);
      o[k]=j!==null?j:(v.length>16000?v.slice(0,16000):v);
    });
    return count?o:null;
  }
  function readBody(raw,reqCT){
    var out={body:null,rawText:"",format:"json"};
    if(raw==null)return Promise.resolve(out);
    try{
      if(typeof FormData!=="undefined"&&raw instanceof FormData){
        var fd={},fc=0;
        raw.forEach(function(v,k){
          if(fc>=60)return;fc++;
          if(typeof v==="string"){var jp=tryParseJson(v);fd[k]=jp!==null?jp:v.slice(0,16000);}
          else{fd[k]="[file:"+(v&&v.name?v.name:"blob")+"]";}
        });
        out.body=fd;out.rawText=JSON.stringify(fd);out.format="multipart";
        return Promise.resolve(out);
      }
      if(typeof URLSearchParams!=="undefined"&&raw instanceof URLSearchParams){
        var rs=raw.toString().slice(0,65536);
        out.body=decodeParams(rs)||rs;out.rawText=rs;out.format="urlencoded";
        return Promise.resolve(out);
      }
      if(typeof raw==="string"){
        var sl=raw.slice(0,65536),ct=(reqCT||"").toLowerCase();
        out.rawText=sl;
        var parsed=tryParseJson(sl);
        if(parsed!==null&&typeof parsed==="object"&&!Array.isArray(parsed)){
          out.body=parsed;
          out.format=ct.indexOf("text/plain")!==-1?"text":"json";
        }else if(ct.indexOf("x-www-form-urlencoded")!==-1||(/^[^\\s{[<][^=&]*=[^&]*/.test(sl.trim())&&sl.indexOf("=")!==-1&&sl.indexOf("\\n")===-1)){
          var up=decodeParams(sl);
          out.body=up||sl;out.format="urlencoded";
        }else{
          out.body=sl;out.format="text";
        }
        return Promise.resolve(out);
      }
      if(typeof ArrayBuffer!=="undefined"&&(raw instanceof ArrayBuffer||ArrayBuffer.isView(raw))){
        var txt=new TextDecoder().decode(raw).slice(0,65536);
        return readBody(txt,reqCT);
      }
      if(typeof Blob!=="undefined"&&raw instanceof Blob&&raw.size<=131072){
        return raw.text().then(function(t){return readBody(t,raw.type||reqCT);}).catch(function(){return out;});
      }
    }catch(e){}
    return Promise.resolve(out);
  }
  function isStrongChat(u,m,rawText,ct,sample,tr){
    if(tr==="eventsource"||tr==="websocket")return true;
    if(SSE_CT.test(ct||""))return true;
    if(sample&&CHAT_RES.test(sample))return true;
    if((m==="POST"||m==="PUT")&&rawText&&CHAT_KEY.test(rawText))return true;
    if(m==="GET"&&CHAT_QUERY.test(u)&&!/text\\/html/i.test(ct||""))return true;
    if((m==="POST"||m==="PUT")&&CHAT_URL.test(u))return true;
    return false;
  }
  function shouldCapture(u,m,rawText,ct,sample,tr){
    if(isStrongChat(u,m,rawText,ct,sample,tr))return true;
    if((m==="POST"||m==="PUT")&&!/text\\/html|image\\/|audio\\/|video\\/|font\\//i.test(ct||""))return true;
    if(m==="GET"&&u.indexOf("?")!==-1&&/json|event-stream|ndjson|text\\/plain/i.test(ct||"")&&sample&&sample.length>8&&sample.trim().charAt(0)!=="<")return true;
    return false;
  }
  function toast(msg,tone){
    try{
      if(!document.body)return;
      if(!badge){
        badge=document.createElement("div");
        badge.setAttribute("data-proxy-studio","1");
        badge.style.cssText="position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:#1b211d;color:#edf5ea;border:1px solid #354738;font:500 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.3);max-width:370px";
        document.body.appendChild(badge);
      }
      badge.innerHTML="";
      var color=tone==="ok"?"#c9ef7e":tone==="warn"?"#f5c451":tone==="err"?"#f28b75":"#7cc46b";
      var dot=document.createElement("span");
      dot.style.cssText="width:8px;height:8px;border-radius:50%;flex:none;background:"+color;
      var txt=document.createElement("span");txt.textContent=msg;
      var x=document.createElement("button");x.textContent="×";x.title="Stop Proxy Studio capture";
      x.style.cssText="border:0;background:none;color:#99aa9b;cursor:pointer;font-size:15px;line-height:1;padding:0 2px;margin-left:auto";
      x.onclick=function(){stop();};
      badge.appendChild(dot);badge.appendChild(txt);badge.appendChild(x);
    }catch(e){}
  }
  function logCspFallback(){
    console.log("%c❌ Auto-send was blocked by this website's security policy (CSP).","background:#fff1ee;color:#a82c18;font-weight:700;padding:4px 8px;border-radius:4px;border-left:3px solid #d9462f");
    console.log("%c👉 Fix: Type  copy(__proxyCapture.last)  in this console and press Enter, then paste it into the \\"Manual Paste Fallback\\" box in Proxy Studio.","background:#eef8e9;color:#1f5722;font-weight:700;padding:4px 8px;border-radius:4px;border-left:3px solid #4c9a3d");
    if(!cspBannerShown){
      cspBannerShown=true;
      toast("Blocked by site CSP — type copy(__proxyCapture.last) in Console & paste in Studio","warn");
    }
  }
  function record(p){
    if(!active||sent>=40)return;
    var k=p.transport+"|"+p.method+"|"+p.url+"|"+(p.looksLikeChat?1:0);
    if(!p.looksLikeChat&&seen[k])return;
    seen[k]=1;sent++;
    var hdrs=Object.assign({},p.headers||{});
    var pgUrl=p.pageUrl||location.href,pgOrg=p.pageOrigin||location.origin;
    if(!hdrs.Origin&&!hdrs.origin)hdrs.Origin=pgOrg;
    if(!hdrs.Referer&&!hdrs.referer)hdrs.Referer=pgUrl;
    var payload={
      sessionId:SID,
      transport:p.transport,
      url:p.url,
      method:p.method,
      headers:hdrs,
      pageUrl:pgUrl,
      pageOrigin:pgOrg,
      bodyFormat:p.bodyFormat||"json",
      requestBody:p.requestBody===undefined?null:p.requestBody,
      responseStatus:p.status||0,
      responseContentType:p.ct||"",
      responseSample:String(p.sample||"").slice(0,6000),
      looksLikeChat:!!p.looksLikeChat,
      capturedAt:new Date().toISOString()
    };
    API_STORE.all.push(payload);
    if(API_STORE.all.length>30)API_STORE.all.shift();
    if(p.looksLikeChat||!API_STORE.last)API_STORE.last=payload;
    if(!HAS_CB){
      if(p.looksLikeChat){
        console.log("%c📡 [Proxy Studio] Caught request: "+p.method+" "+p.url+" (saved locally!)","color:#2f7d32;font-weight:700");
        console.log("%c👉 Fix / Next: Type  copy(__proxyCapture.last)  and press Enter, then paste into Proxy Studio's Manual Paste box!","background:#eef8e9;color:#1f5722;font-weight:700;padding:4px 8px;border-radius:4px");
        toast("Captured! Type copy(__proxyCapture.last) in Console & paste in Studio","ok");
      }
      return;
    }
    if(p.looksLikeChat){
      console.log("%c📡 [Proxy Studio] Caught request: "+p.method+" "+p.url+" (analyzing...)","color:#2f7d32;font-weight:700");
      toast("Caught request — sending to Proxy Studio...","info");
    }
    try{
      nativeFetch(CB,{method:"POST",mode:"cors",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}).then(function(r){
        return r.json().catch(function(){return {ok:false,httpStatus:r.status};});
      }).then(function(d){
        if(d&&d.status==="completed"){
          console.log("%c🎉 [Proxy Studio] Sent & verified! You can return to Proxy Studio now. ("+(d.adapter&&d.adapter.name||"Adapter saved")+")","background:#e6f6df;color:#1d5e20;font-weight:700;padding:4px 8px;border-radius:4px");
          toast("Verified & saved! Return to Proxy Studio","ok");
          setTimeout(stop,5000);
        }else if(d&&d.kind==="probe_failed"&&p.looksLikeChat){
          console.log("%c⚠️ [Proxy Studio] "+(d.message||"Could not verify that call yet — try sending 1 more message or paste Copy as cURL."),"color:#9a5d14;font-weight:600");
          toast("Listening — check Studio for a quick tip","warn");
        }else if(d&&d.message&&p.looksLikeChat){
          console.log("%cℹ️ [Proxy Studio] "+d.message,"color:#4c6e52");
          toast("Still listening — send 1 message in the chat","info");
        }
      }).catch(function(){
        logCspFallback();
      });
    }catch(e){
      logCspFallback();
    }
  }
  function sampleRes(res,ct){
    return new Promise(function(resolve){
      try{
        var c=res.clone();
        if(!c.body||!c.body.getReader){c.text().then(function(t){resolve(String(t||"").slice(0,6000));}).catch(function(){resolve("");});return;}
        var rd=c.body.getReader(),dec=new TextDecoder(),out="",n=0,done=false;
        var isS=SSE_CT.test(ct||"");
        var tm=setTimeout(function(){if(!done){done=true;try{rd.cancel();}catch(e){}resolve(out.slice(0,6000));}},isS?4000:5000);
        function pump(){
          rd.read().then(function(r){
            if(done)return;
            if(r.value){out+=dec.decode(r.value,{stream:!r.done});n++;}
            if(r.done||out.length>=4096||(isS&&n>=4&&out.length>=80)){
              done=true;clearTimeout(tm);try{rd.cancel();}catch(e){}resolve(out.slice(0,6000));return;
            }
            pump();
          }).catch(function(){if(!done){done=true;clearTimeout(tm);resolve(out.slice(0,6000));}});
        }
        pump();
      }catch(e){resolve("");}
    });
  }
  function hookWin(w,isFrame){
    if(!w||hookedSet.indexOf(w)!==-1)return;
    var locHref=location.href,locOrg=location.origin;
    try{locHref=w.location.href;locOrg=w.location.origin;}catch(e){return;}
    hookedSet.push(w);
    var wf=w.fetch?w.fetch.bind(w):null;
    var XHR=w.XMLHttpRequest,oOpen=XHR&&XHR.prototype.open,oHdr=XHR&&XHR.prototype.setRequestHeader,oSend=XHR&&XHR.prototype.send;
    var oES=w.EventSource,oWS=w.WebSocket;
    if(wf){
      w.fetch=function(input,init){
        var url="",method="GET",hdrs={},bodyProm=null,cap=false;
        try{
          var isReq=typeof w.Request!=="undefined"&&input instanceof w.Request;
          url=abs(isReq?input.url:(input&&input.href?input.href:input),locHref);
          method=String((init&&init.method)||(isReq&&input.method)||"GET").toUpperCase();
          if(active&&!skip(url)){
            cap=true;
            if(isReq)hdrs=Object.assign(hdrs,hdrObj(input.headers));
            if(init&&init.headers)hdrs=Object.assign(hdrs,hdrObj(init.headers));
            var rct=getCT(hdrs);
            if(init&&init.body!==undefined&&init.body!==null){bodyProm=readBody(init.body,rct);}
            else if(isReq&&method!=="GET"&&method!=="HEAD"){
              try{bodyProm=input.clone().text().then(function(t){return readBody(t,rct);}).catch(function(){return {body:null,rawText:"",format:"json"};});}catch(e){}
            }
          }
        }catch(e){}
        var p=wf.apply(w,arguments);
        if(cap){
          p.then(function(res){
            try{
              var ct=(res.headers&&res.headers.get("content-type"))||"";
              var bp=bodyProm||Promise.resolve({body:null,rawText:"",format:"json"});
              bp.then(function(bi){
                var quickChat=isStrongChat(url,method,bi.rawText,ct,"","fetch");
                var candidate=quickChat||method==="POST"||method==="PUT"||(method==="GET"&&url.indexOf("?")!==-1&&!/text\\/html/i.test(ct));
                if(!candidate)return;
                sampleRes(res,ct).then(function(sample){
                  if(shouldCapture(url,method,bi.rawText,ct,sample,"fetch")){
                    var strong=isStrongChat(url,method,bi.rawText,ct,sample,"fetch");
                    record({transport:"fetch",url:url,method:method,headers:hdrs,bodyFormat:bi.format,requestBody:bi.body,status:res.status,ct:ct,sample:sample,pageUrl:locHref,pageOrigin:locOrg,looksLikeChat:strong});
                  }
                });
              });
            }catch(e){}
          },function(){});
        }
        return p;
      };
      restorers.push(function(){try{w.fetch=wf;}catch(e){}});
    }
    if(XHR&&oOpen&&oSend){
      XHR.prototype.open=function(m,u){
        try{this.__ps={m:String(m||"GET").toUpperCase(),u:abs(u,locHref),h:{}};}catch(e){}
        return oOpen.apply(this,arguments);
      };
      XHR.prototype.setRequestHeader=function(k,v){
        try{if(this.__ps)this.__ps.h[String(k)]=String(v);}catch(e){}
        return oHdr.apply(this,arguments);
      };
      XHR.prototype.send=function(body){
        var x=this;
        try{
          if(active&&x.__ps&&!skip(x.__ps.u)){
            var meta=x.__ps,bp=readBody(body,getCT(meta.h));
            x.addEventListener("loadend",function(){
              try{
                var ct=x.getResponseHeader("content-type")||"";
                var sample=(x.responseType===""||x.responseType==="text")?String(x.responseText||"").slice(0,6000):"";
                bp.then(function(bi){
                  if(shouldCapture(meta.u,meta.m,bi.rawText,ct,sample,"xhr")){
                    var strong=isStrongChat(meta.u,meta.m,bi.rawText,ct,sample,"xhr");
                    record({transport:"xhr",url:meta.u,method:meta.m,headers:meta.h,bodyFormat:bi.format,requestBody:bi.body,status:x.status,ct:ct,sample:sample,pageUrl:locHref,pageOrigin:locOrg,looksLikeChat:strong});
                  }
                });
              }catch(e){}
            });
          }
        }catch(e){}
        return oSend.apply(this,arguments);
      };
      restorers.push(function(){try{XHR.prototype.open=oOpen;XHR.prototype.setRequestHeader=oHdr;XHR.prototype.send=oSend;}catch(e){}});
    }
    if(oES){
      var WES=function(u,cfg){
        var es=cfg!==undefined?new oES(u,cfg):new oES(u);
        try{
          var full=abs(u,locHref);
          if(active&&!skip(full)){
            var chunks=[],flushed=false;
            var flush=function(){if(flushed)return;flushed=true;try{es.removeEventListener("message",onM);}catch(e){}record({transport:"eventsource",url:full,method:"GET",headers:{},bodyFormat:"json",requestBody:null,status:200,ct:"text/event-stream",sample:chunks.join("\\n"),pageUrl:locHref,pageOrigin:locOrg,looksLikeChat:true});};
            var tm=setTimeout(flush,3500);
            var onM=function(ev){chunks.push("data: "+String(ev&&ev.data||""));if(chunks.length>=5||chunks.join("\\n").length>=3000){clearTimeout(tm);flush();}};
            es.addEventListener("message",onM);
          }
        }catch(e){}
        return es;
      };
      WES.prototype=oES.prototype;WES.CONNECTING=oES.CONNECTING;WES.OPEN=oES.OPEN;WES.CLOSED=oES.CLOSED;
      w.EventSource=WES;
      restorers.push(function(){try{w.EventSource=oES;}catch(e){}});
    }
    if(oWS){
      var WWS=function(u,protos){
        var ws=protos!==undefined?new oWS(u,protos):new oWS(u);
        try{
          var full=abs(u,locHref);
          if(active&&!skip(full)){
            var origSend=ws.send.bind(ws),lastOut=null,inFrames=[],wsTm=null,wsDone=false;
            var flushWs=function(){
              if(wsDone||lastOut===null)return;wsDone=true;
              var parsed=tryParseJson(lastOut);
              record({transport:"websocket",url:full,method:"WS",headers:{},bodyFormat:parsed?"json":"text",requestBody:parsed!==null?parsed:lastOut,status:101,ct:"application/websocket",sample:inFrames.join("\\n").slice(0,6000),pageUrl:locHref,pageOrigin:locOrg,looksLikeChat:true});
            };
            ws.send=function(data){
              try{
                if(active&&typeof data==="string"&&data.length>=2&&!/^(?:ping|pong|2|3|heartbeat|\\{\\s*"type"\\s*:\\s*"ping")/i.test(data.trim())){
                  lastOut=data.slice(0,32768);
                  inFrames=[];wsDone=false;
                  if(wsTm)clearTimeout(wsTm);
                  wsTm=setTimeout(flushWs,3200);
                }
              }catch(e){}
              return origSend(data);
            };
            ws.addEventListener("message",function(ev){
              try{
                if(!active||wsDone||lastOut===null)return;
                if(typeof ev.data==="string"&&ev.data.trim()){
                  inFrames.push(ev.data.slice(0,1500));
                  if(inFrames.length>=6||inFrames.join("\\n").length>=3000){if(wsTm)clearTimeout(wsTm);flushWs();}
                }
              }catch(e){}
            });
          }
        }catch(e){}
        return ws;
      };
      WWS.prototype=oWS.prototype;WWS.CONNECTING=oWS.CONNECTING;WWS.OPEN=oWS.OPEN;WWS.CLOSING=oWS.CLOSING;WWS.CLOSED=oWS.CLOSED;
      w.WebSocket=WWS;
      restorers.push(function(){try{w.WebSocket=oWS;}catch(e){}});
    }
    if(isFrame){
      try{console.log("%c🔗 [Proxy Studio] Auto-hooked same-origin iframe: "+locHref,"color:#4c7a49");}catch(e){}
    }
  }
  function scanFrames(doc){
    if(!doc||!doc.querySelectorAll)return;
    var list=[],cross=[];
    try{list=doc.querySelectorAll("iframe");}catch(e){return;}
    for(var i=0;i<list.length;i++){
      var f=list[i],src="";
      try{src=f.getAttribute("src")||f.src||"";}catch(e){}
      if(src&&AD_FRAME.test(src))continue;
      var sameOk=false;
      try{
        var cw=f.contentWindow;
        if(cw&&cw.document&&cw.location&&cw.location.origin===location.origin){
          sameOk=true;
          hookWin(cw,true);
          if(!f.__psLoad){f.__psLoad=1;f.addEventListener("load",function(){try{if(active&&this.contentWindow)hookWin(this.contentWindow,true);}catch(e){}});}
        }
      }catch(e){sameOk=false;}
      if(!sameOk){
        var full=src?abs(src,location.href):"(embedded iframe)";
        if(!warnedFrames[full]){warnedFrames[full]=1;cross.push(full);API_STORE.iframes.push(full);}
      }
    }
    if(cross.length){
      console.warn("%c⚠️ Detected embedded iframe(s) on this page! If nothing is captured after you send a message, click the \\"top\\" dropdown at the top-left of DevTools Console, switch it to the chat iframe, and paste this script again.","background:#fff8db;color:#7a4f01;font-weight:700;padding:6px 10px;border-radius:4px;border-left:3px solid #e0a100");
      console.warn("   Found iframe(s): "+cross.slice(0,5).join(" , "));
      toast("Embedded iframe detected — switch 'top' in Console if nothing catches","warn");
    }
  }
  function help(){
    console.log("Proxy Studio helpers:\\n  copy(__proxyCapture.last)  -> copy the latest captured request JSON\\n  copy(__proxyCapture.all)   -> copy all captured requests\\n  __proxyCapture.stop()      -> detach hooks and restore the page");
  }
  function stop(){
    if(!active)return;active=false;
    for(var i=0;i<restorers.length;i++){try{restorers[i]();}catch(e){}}
    restorers=[];hookedSet=[];
    try{if(mo)mo.disconnect();}catch(e){}
    try{if(badge&&badge.parentNode)badge.parentNode.removeChild(badge);}catch(e){}
    badge=null;
  }
  hookWin(window,false);
  window.__proxyCapture=API_STORE;
  window.__proxyStudioCapture=API_STORE;
  console.log("%c✅ [Proxy Studio] Capture active! Now type and send 1 message in the chat.","background:#e9f7e4;color:#1e5c22;font-weight:700;padding:5px 9px;border-radius:4px;border-left:3px solid #4c9a3d");
  if(!HAS_CB){
    console.log("%cℹ️ Running in Global mode: after you send 1 message, type  copy(__proxyCapture.last)  and paste it into Proxy Studio.","color:#4a6b4e");
  }
  toast("Proxy Studio listening — send 1 message in chat","info");
  try{
    scanFrames(document);
    if(typeof MutationObserver!=="undefined"&&document.documentElement){
      mo=new MutationObserver(function(muts){
        if(!active)return;
        for(var i=0;i<muts.length;i++){
          var added=muts[i].addedNodes;
          for(var j=0;j<added.length;j++){
            var n=added[j];
            if(n&&n.nodeType===1&&(n.tagName==="IFRAME"||(n.querySelector&&n.querySelector("iframe")))){scanFrames(document);return;}
          }
        }
      });
      mo.observe(document.documentElement,{childList:true,subtree:true});
    }
  }catch(e){}
})();`;

  if (!compact) return code;
  return code
    .split("\n")
    .map((line) => line.trim())
    .join("");
}

export function buildCaptureArtifacts(
  callbackOrigin: string,
  sessionId: string,
  opts?: { manualOnly?: boolean },
): {
  callbackUrl: string;
  consoleSnippet: string;
  bookmarklet: string;
} {
  const cleanOrigin = (callbackOrigin || "").replace(/\/+$/, "");
  const callbackUrl =
    opts?.manualOnly || !cleanOrigin
      ? ""
      : `${cleanOrigin}/api/capture/ingest?sessionId=${encodeURIComponent(sessionId)}`;
  const consoleSnippet = buildCaptureCore(callbackUrl, sessionId, false);
  const compact = buildCaptureCore(callbackUrl, sessionId, true);
  const bookmarklet = `javascript:${encodeURIComponent(compact)}`;
  return { callbackUrl, consoleSnippet, bookmarklet };
}
