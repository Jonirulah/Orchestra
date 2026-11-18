// Escribe state.json de prueba: N paneles «Claude» con el emulador.
const fs=require('fs');
const N=+process.argv[2]||6, data=process.argv[3], ign=JSON.parse(process.argv[4]||'[]');
const acct='E:\\_cache\\lagr-test\\acct';
fs.rmSync(acct+'\\sessions',{recursive:true,force:true});
fs.rmSync(acct+'\\projects',{recursive:true,force:true});
const cols=3, rws=Math.ceil(N/cols);
const panes=[];
for(let i=0;i<N;i++) panes.push({id:'p_emu'+i,col:i%cols,row:Math.floor(i/cols),colSpan:1,rowSpan:1,parked:false,kind:'agent',icon:'claude',title:'Claude '+i,ref:'acc_emu',
  spec:{program:'C:\\Program Files\\nodejs\\node.exe',args:['E:\\_cache\\lagr-test\\emu.cjs',acct,String(i)],cwd:'E:\\Orchestra-wt\\lag-render'}});
const st={workspaces:[{id:'w1',name:'Main',cols:Array(cols).fill(1/cols),rows:Array(rws).fill(1/rws),panes}],activeId:'w1',hosts:[],
 accounts:[{id:'acc_emu',name:'Emu',dir:acct,isDefault:false,color:'#f5b942',provider:'claude'}],
 ignoredDirs:ign,
 settings:{scrollback:5000,scanIntervalSec:2,claudeMarkdownColor:true,claudeThemes:true,claudeThemeSet:false,gitChip:true,gitCounts:true,gitTrackFolder:true,gitIntervalSec:5,
  usageQuery:false,autoCompact:true,windowOpacity:100,windowEffect:'none',autoUpdate:false,restoreClaudeSessions:false,language:'es'}};
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(data+'/state.json',JSON.stringify(st));
console.log('seeded',N);
