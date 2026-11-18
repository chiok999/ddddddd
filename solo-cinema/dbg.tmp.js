const fs=require('fs'),path=require('path');const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
const html=fs.readFileSync('public/index.html','utf8');
const dom=new JSDOM(html,{url:'https://cinema.example/',runScripts:'outside-only'});
const w=dom.window,d=w.document; w.scrollTo=()=>{};
const sections=[
 {id:'popular-movies',title:'PM',source:'Cinemeta',groups:['movies'],items:[{id:'m1',title:'A Film',type:'movie',year:'2024',overview:'',poster:null,imdbId:'tt0111161',source:'cinemeta'}]},
 {id:'popular-series',title:'PS',source:'Cinemeta',groups:['shows'],items:[{id:'s1',title:'A Series',type:'series',year:'2021',overview:'',poster:null,imdbId:'tt0068646',source:'cinemeta'}]}];
w.fetch=async url=>({ok:true,json:async()=>{ if(url==='/api/session')return{authenticated:true}; if(url==='/api/discover')return{sections}; throw Error(url);}});
w.localStorage.setItem('solo-progress',JSON.stringify([{url:'cinemeta:A Series',time:1200,duration:3600}]));
w.eval(fs.readFileSync('public/fallback.js','utf8'));
w.eval(fs.readFileSync('public/app.js','utf8'));
setTimeout(()=>{
  const card=()=>d.querySelector('#continue-watching .catalog-card');
  console.log('BEFORE filter small:',card()?.querySelector('small')?.textContent);
  w.location.hash='#movies'; w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  console.log('AFTER  filter small:',card()?.querySelector('small')?.textContent);
  console.log('aria:',card()?.getAttribute('aria-label'));
  console.log('dataset.item present?',card()?.dataset.item!==undefined);
},400);
