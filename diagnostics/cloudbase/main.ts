import cloudbase from '@cloudbase/js-sdk';
import { fetchJsonWithTimeout } from './http';
import '../../src/client/style.css';

type Phase = 'waiting' | 'running' | 'paused' | 'timeout' | 'aborted';
type Action = 'join' | 'snapshot' | 'pulse' | 'start';
interface ProbeReply {
  count: number;
  version: number;
  seat: 1 | 2;
  phase: Phase;
  turnSeat: 1 | 2;
  remainingMs: number;
  turnDeadline: number | null;
  offlineDeadline: number | null;
  ownerOnline: boolean;
  guestOnline: boolean;
  loserSeat: number | null;
  winnerSeat: number | null;
  serverNow: number;
  expiresAt: number;
  accepted: boolean;
  rejection: string | null;
}

const element=(id:string)=>document.getElementById(id)!;
const button=(id:string)=>element(id) as HTMLButtonElement;
const env=import.meta.env.VITE_CLOUDBASE_ENV_ID as string | undefined;
const accessKey=import.meta.env.VITE_CLOUDBASE_PUBLISHABLE_KEY as string | undefined;
const app=env&&accessKey?cloudbase.init({env,accessKey,region:'ap-shanghai'}):null;
let room=location.hash.slice(1)||sessionStorage.getItem('cloudbaseProbeRoom')||'';
if(!/^[a-f0-9-]{36}$/.test(room)) room='';
history.replaceState(null,'',location.pathname);
let generation=0;
let version=0;
let count=0;
let seat:1|2=1;
let phase:Phase='waiting';
let turnSeat:1|2=1;
let remainingMs=60_000;
let timerDeadlinePerf:number|null=null;
let lastServerNow=0;
let ownerOnline=false;
let guestOnline=false;
let attempts=0;
let updates=0;
let polls=0;
let joined=false;
let simulatedDisconnect=false;
let pollTimer:number|undefined;
let pollBusy=false;
const times:number[]=[];
const pollIntervalMs=10_000;
const heartbeatWriteIntervalMs=15_000;
const status=(text:string)=>{element('status').textContent=text;};

function createId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function stopPolling(){
  if(pollTimer!==undefined){window.clearInterval(pollTimer);pollTimer=undefined;}
}

function isProbeReply(value:unknown):value is ProbeReply{
  if(!value||typeof value!=='object')return false;
  const reply=value as Record<string,unknown>;
  return typeof reply.count==='number'&&typeof reply.version==='number'
    &&(reply.seat===1||reply.seat===2)
    &&(['waiting','running','paused','timeout','aborted'] as unknown[]).includes(reply.phase)
    &&(reply.turnSeat===1||reply.turnSeat===2)
    &&typeof reply.remainingMs==='number'
    &&(reply.turnDeadline===null||typeof reply.turnDeadline==='number')
    &&(reply.offlineDeadline===null||typeof reply.offlineDeadline==='number')
    &&typeof reply.ownerOnline==='boolean'&&typeof reply.guestOnline==='boolean'
    &&(reply.loserSeat===null||typeof reply.loserSeat==='number')
    &&(reply.winnerSeat===null||typeof reply.winnerSeat==='number')
    &&typeof reply.serverNow==='number'&&typeof reply.expiresAt==='number'
    &&typeof reply.accepted==='boolean'
    &&(reply.rejection===null||typeof reply.rejection==='string');
}

function renderTimer(){
  const ms=phase==='running'&&timerDeadlinePerf!==null
    ?Math.max(0,timerDeadlinePerf-performance.now()):remainingMs;
  element('timer').textContent=`${(ms/1_000).toFixed(1)} 秒`;
  element('phase').textContent=({
    waiting:'等待开始',running:'计时中',paused:'断线暂停',timeout:'超时结束',aborted:'已中止',
  } satisfies Record<Phase,string>)[phase];
  element('turn').textContent=phase==='waiting'?'等待开始'
    :phase==='timeout'?`第 ${turnSeat} 席超时`
    :phase==='aborted'?'无胜负'
    :`第 ${turnSeat} 席行棋`;
  element('presence').textContent=`1号 ${ownerOnline?'在线':'离线'}；2号 ${guestOnline?'在线':'离线'}`;
  const gameStatus=element('gameStatus');
  if(phase==='waiting')gameStatus.textContent=ownerOnline&&guestOnline?'双方已连接，可以开始 60 秒测试。':'等待双方连接并同步。';
  else if(phase==='running')gameStatus.textContent=ms===0?'时间到，等待服务端裁决。':`服务端计时中：第 ${turnSeat} 席需在倒计时内模拟落子。`;
  else if(phase==='paused')gameStatus.textContent='服务端已暂停计时；双方须在 5 分钟内恢复。';
  else if(phase==='timeout')gameStatus.textContent=`第 ${turnSeat} 席超时判负，第 ${turnSeat===1?2:1} 席获胜。`;
  else gameStatus.textContent='断线等待超过 5 分钟，对局已中止，不判负。';
  button('startTimer').disabled=!joined||phase!=='waiting'||!ownerOnline||!guestOnline||simulatedDisconnect;
  button('send').disabled=!joined||simulatedDisconnect||phase==='paused'||phase==='timeout'||phase==='aborted'||(phase==='running'&&seat!==turnSeat);
  button('disconnect').disabled=!joined||simulatedDisconnect||phase!=='running';
  button('disconnect').hidden=simulatedDisconnect;
  button('reconnect').hidden=!simulatedDisconnect;
}

function applyReply(reply:ProbeReply,requestRoom:string){
  if(requestRoom!==room||reply.version<version||reply.serverNow<lastServerNow)return;
  version=reply.version;count=reply.count;seat=reply.seat;phase=reply.phase;turnSeat=reply.turnSeat;
  remainingMs=reply.remainingMs;ownerOnline=reply.ownerOnline;guestOnline=reply.guestOnline;
  lastServerNow=reply.serverNow;
  timerDeadlinePerf=reply.turnDeadline===null?null:performance.now()+reply.turnDeadline-reply.serverNow;
  element('count').textContent=String(count);
  renderTimer();
}

async function call(action:Action,id:string|null=null):Promise<ProbeReply>{
  if(!app)throw new Error('未配置环境，尚未连接云端');
  const requestRoom=room;
  const session=await app.auth().getSession();
  const token=session.data.session?.access_token;
  if(session.error||!token)throw new Error('登录状态已失效，请重新连接');
  const {response,body}=await fetchJsonWithTimeout(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/gomoku_diag_command`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:JSON.stringify({p_room:room,p_action:action,p_operation:id,p_version:action==='pulse'?version:null}),
  },10_000);
  if(!response.ok||!isProbeReply(body))throw new Error('服务端未确认，请检查环境配置');
  applyReply(body,requestRoom);
  return body;
}

async function refreshSnapshot(current:number){
  if(!joined||pollBusy||current!==generation||simulatedDisconnect)return;
  pollBusy=true;polls++;
  const previousVersion=version;
  try{
    const reply=await call('snapshot');
    if(current===generation&&reply.version>previousVersion){
      updates++;
      status(`设备 ${reply.seat}：已通过 HTTP 轮询同步最新数据`);
    }
  }catch{
    if(current===generation)status('轮询暂时失败；网络恢复后会自动重试');
  }finally{pollBusy=false;}
}

function startPolling(current:number){
  if(document.hidden||pollTimer!==undefined||!joined||current!==generation||simulatedDisconnect)return;
  void refreshSnapshot(current);
  pollTimer=window.setInterval(()=>{void refreshSnapshot(current);},pollIntervalMs);
}

function handleVisibilityChange(){
  if(!joined)return;
  if(document.hidden)stopPolling();
  else startPolling(generation);
}

async function connect(){
  if(!app||!room){status('请先配置环境或新建测试');return;}
  const current=++generation;
  stopPolling();
  pollBusy=false;
  attempts++;joined=false;button('send').disabled=true;
  try{
    const session=await app.auth().getSession();
    if(session.error)throw new Error('无法核对登录状态，请重试');
    if(!session.data.session){const login=await app.auth().signInAnonymously();if(login.error)throw new Error('访客登录未启用或连接失败');}
    const reply=await call('join');if(current!==generation)return;
    simulatedDisconnect=false;sessionStorage.setItem('cloudbaseProbeRoom',room);
    joined=true;button('invite').disabled=false;
    status(`设备 ${reply.seat}：HTTP 轮询已连接，每 10 秒核对服务端状态`);
    startPolling(current);
  }catch(error){status(error instanceof Error?error.message:'连接失败');}
  renderTimer();
}

async function copy(text:string){
  try{await navigator.clipboard.writeText(text);status('已复制');}
  catch{const box=element('copy') as HTMLTextAreaElement;box.hidden=false;box.value=text;box.focus();box.select();status('请长按文本复制');}
}

button('new').onclick=()=>{
  room=createId();version=0;count=0;lastServerNow=0;phase='waiting';turnSeat=1;remainingMs=60_000;
  ownerOnline=false;guestOnline=false;joined=false;simulatedDisconnect=false;void connect();
};
button('join').onclick=()=>{void connect();};
button('invite').onclick=()=>{void copy(`${location.origin}${location.pathname}#${room}`);};
button('startTimer').onclick=()=>{
  button('startTimer').disabled=true;
  void call('start').then(reply=>{
    if(!reply.accepted)status(`开始失败：${reply.rejection??'请重新同步'}`);
  }).catch(error=>status(error instanceof Error?error.message:'开始失败')).finally(renderTimer);
};
button('send').onclick=()=>{
  if(!joined)return;
  button('send').disabled=true;const at=performance.now();
  void call('snapshot').then(snapshot=>{
    if(!snapshot.accepted)throw new Error(snapshot.rejection??'请重新同步');
    return call('pulse',createId());
  }).then(reply=>{
    if(!reply.accepted)throw new Error(reply.rejection??'请重新同步');
    times.push(Math.round(performance.now()-at));
    element('latency').textContent=`最近确认 ${times[times.length-1]} ms；${times.length} 个样本`;
    status(phase==='running'?`第 ${reply.turnSeat} 席获得新的 60 秒回合`:'计数已保存；对方通过 HTTP 轮询获取');
  }).catch(error=>status(error instanceof Error?`未接受：${error.message}`:'未接受，请重新连接')).finally(renderTimer);
};
button('disconnect').onclick=()=>{
  simulatedDisconnect=true;stopPolling();status('已模拟断线：此设备停止轮询，服务端会按最后活动时间判断离线');renderTimer();
};
button('reconnect').onclick=()=>{simulatedDisconnect=false;void connect();};
button('report').onclick=()=>{
  void copy(JSON.stringify({candidate:'CloudBase server timer probe',time:new Date().toISOString(),attempts,polls,updates,count,phase,turnSeat,remainingMs,pollIntervalMs,heartbeatWriteIntervalMs,acknowledgementMs:times,limitations:'计时状态由 CloudBase PostgreSQL RPC 持久化；页面以服务端截止时间显示倒计时。离线结算在下一次服务端请求时惰性执行；不调用 Realtime，不含正式棋盘。'},null,2));
};

document.addEventListener('visibilitychange',handleVisibilityChange);
window.addEventListener('pageshow',handleVisibilityChange);
window.addEventListener('pagehide',stopPolling);
window.setInterval(renderTimer,250);
if(!app)status('尚未配置云端环境；当前仅完成本地构建准备');else if(room)void connect();
else status('请新建测试或打开邀请链接加入');
