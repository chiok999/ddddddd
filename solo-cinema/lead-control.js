'use strict';
// HLS EVENT playlists contain only finalized, atomically published segments.
function playlistDuration(text){
 let seconds=0,found=false;
 for(const line of text.split(/\r?\n/)){
  if(!line.startsWith('#EXTINF:'))continue;
  const raw=line.slice(8).split(',',1)[0];
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))return null;
  const value=Number(raw);if(!Number.isFinite(value) || value<=0)return null;
  seconds+=value;found=true;
 }
 return found && Number.isFinite(seconds)?seconds:null;
}
function leadAction({paused,buffered,playhead,lastReport,now,ahead=1200,hysteresis=60,staleMs=60000}){
 if(!Number.isFinite(playhead) || !Number.isFinite(lastReport) || now-lastReport>staleMs)return paused?'resume':null;
 if(!Number.isFinite(buffered))return null;
 const lead=buffered-playhead;
 if(!paused && lead>=ahead)return 'pause';
 if(paused && lead<=Math.max(0,ahead-hysteresis))return 'resume';
 return null;
}
module.exports={playlistDuration,leadAction};
