'use strict';
// Classify only explicit file extensions. Opaque URLs remain HLS/unknown and
// are not promoted to MP4 merely because a provider labels them a stream.
function sourceFormat(url){const path=new URL(url).pathname;if(/\.m3u8$/i.test(path))return 'hls';if(/\.(?:mp4|m4v)$/i.test(path))return 'file';return 'hls';}
module.exports={sourceFormat};
