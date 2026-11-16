// RFC 5545 export. Start-time events only: Hitch does not know arrival times.
const escapeText=value=>String(value || '').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
const stamp=value=>{
  if(typeof value!=='string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Trip time is unavailable. Refresh and try again.');
  return new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
};
function fold(line){
  let result='',width=0; const encoder=new TextEncoder();
  for(const char of line){const size=encoder.encode(char).length;if(width+size>75){result+='\r\n ';width=1;}result+=char;width+=size;}
  return result;
}
export function tripCalendar({id,origin,destination,pickup,dropoff,departureAt,returnAt},now=new Date()){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw new Error('Trip is unavailable. Refresh and try again.');
  const outbound=stamp(departureAt), back=returnAt?stamp(returnAt):null;
  if(back && Date.parse(returnAt)<=Date.parse(departureAt)) throw new Error('Return must be after departure.');
  const updated=stamp(now.toISOString()),lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Hitch//Trip Calendar//EN','CALSCALE:GREGORIAN'];
  function event(leg,start,title,location,description){lines.push('BEGIN:VEVENT',`UID:${id}-${leg}@hitched-carpool.onrender.com`,`DTSTAMP:${updated}`,`DTSTART:${start}`,`SUMMARY:${escapeText(title)}`,`LOCATION:${escapeText(location)}`,`DESCRIPTION:${escapeText(description+'\nCheck Hitch for changes. This calendar file does not update automatically.')}`,'END:VEVENT');}
  event('outbound',outbound,`Hitch: ${origin} → ${destination}`,pickup,`Pickup: ${pickup}\nDrop-off: ${dropoff}`);
  if(back) event('return',back,`Hitch: ${destination} → ${origin}`,destination,'Return pickup time. Confirm the meeting spot with your driver.');
  lines.push('END:VCALENDAR');return lines.map(fold).join('\r\n')+'\r\n';
}
export function downloadCalendar(trip){
  const content=tripCalendar(trip),blob=new Blob([content],{type:'text/calendar;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='hitch-'+trip.id+'.ics';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
