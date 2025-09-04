@@ -0,0 +1,101 @@
export const onRequest: PagesFunction<{ DB: D1Database }> = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const json = (o:any,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json'}});
  const bad = (m:string,s=400)=>json({detail:m},s);
  const readBody = async<T=any>()=>{ try{ return await request.json() as T;}catch{return {} as T;} };
  const nowISO = ()=>new Date().toISOString().slice(0,19);

  if(request.method==='GET' && path==='/requests'){
    const status=url.searchParams.get('status'); const orderNo=url.searchParams.get('order_no');
    let sql='SELECT * FROM change_requests'; const where:string[]=[]; const b:any[]=[];
    if(status){where.push('status = ?'); b.push(status);} if(orderNo){where.push('order_no = ?'); b.push(orderNo);}
    if(where.length) sql+=' WHERE '+where.join(' AND '); sql+=' ORDER BY opened_at DESC';
    const r=await env.DB.prepare(sql).bind(...b).all(); return json(r.results);
  }

  if(request.method==='POST' && path==='/requests'){
    const b=await readBody<{order_no:string;reason:string;comment?:string;opened_by:string}>();
    if(!b.order_no||!b.reason||!b.opened_by) return bad('order_no, reason, opened_by requis');
    const opened_at=nowISO();
    const ins=await env.DB.prepare(
      'INSERT INTO change_requests(order_no,reason,comment,status,opened_by,opened_at) VALUES(?,?,?,?,?,?)'
    ).bind(b.order_no.trim(),b.reason.trim(),b.comment?.trim()||null,'OPEN',b.opened_by.trim(),opened_at).run();
    const id=ins.meta.last_row_id!;
    await env.DB.prepare(
      'INSERT INTO request_events(request_id,event_type,data,at,by_user) VALUES(?,?,?,?,?)'
    ).bind(id,'OPENED',JSON.stringify(b),opened_at,b.opened_by.trim()).run();
    const row=await env.DB.prepare('SELECT * FROM change_requests WHERE id=?').bind(id).first();
    return json(row,201);
  }

  const m=path.match(/^\/requests\/(\d+)(?:\/(events|close|reopen))?$/);
  if(m){
    const id=Number(m[1]); const tail=m[2];

    if(!tail && request.method==='GET'){
      const r=await env.DB.prepare('SELECT * FROM change_requests WHERE id=?').bind(id).first();
      if(!r) return bad('Request not found',404); return json(r);
    }

    if(tail==='events' && request.method==='GET'){
      const rows=await env.DB.prepare(
        'SELECT id,event_type,data,at,by_user FROM request_events WHERE request_id=? ORDER BY at ASC'
      ).bind(id).all();
      return json(rows.results.map((e:any)=>({...e,data:e.data?JSON.parse(e.data):null,by:e.by_user})));
    }

    if(tail==='close' && request.method==='POST'){
      const b=await readBody<{closed_by:string;comment?:string}>(); if(!b.closed_by) return bad('closed_by requis');
      const req=await env.DB.prepare('SELECT status FROM change_requests WHERE id=?').bind(id).first();
      if(!req) return bad('Request not found',404); if(req.status==='CLOSED') return bad('Already closed');
      const closed_at=nowISO();
      await env.DB.prepare('UPDATE change_requests SET status="CLOSED", closed_by=?, closed_at=? WHERE id=?')
        .bind(b.closed_by.trim(),closed_at,id).run();
      await env.DB.prepare('INSERT INTO request_events(request_id,event_type,data,at,by_user) VALUES(?,?,?,?,?)')
        .bind(id,'CLOSED',JSON.stringify(b),closed_at,b.closed_by.trim()).run();
      const row=await env.DB.prepare('SELECT * FROM change_requests WHERE id=?').bind(id).first(); return json(row);
    }

    if(tail==='reopen' && request.method==='POST'){
      const b=await readBody<{reopened_by:string;reason:string;comment?:string}>(); 
      if(!b.reopened_by||!b.reason) return bad('reopened_by et reason requis');
      const req=await env.DB.prepare('SELECT status FROM change_requests WHERE id=?').bind(id).first();
      if(!req) return bad('Request not found',404); if(req.status!=='CLOSED') return bad('Only closed requests can be reopened');
      const at=nowISO();
      await env.DB.prepare('UPDATE change_requests SET status="OPEN", closed_by=NULL, closed_at=NULL WHERE id=?').bind(id).run();
      await env.DB.prepare('INSERT INTO request_events(request_id,event_type,data,at,by_user) VALUES(?,?,?,?,?)')
        .bind(id,'REOPENED',JSON.stringify({reason:b.reason,comment:b.comment||''}),at,b.reopened_by.trim()).run();
      const row=await env.DB.prepare('SELECT * FROM change_requests WHERE id=?').bind(id).first(); return json(row);
    }
  }

  if(request.method==='GET' && path==='/export/csv'){
    const q=await env.DB.prepare(
      `SELECT ev.request_id AS id_demande, cr.order_no AS num_commande,
              ev.event_type AS action, ev.at AS horodatage, ev.by_user AS par,
              ev.data AS data_json, cr.opened_at, cr.closed_at
         FROM request_events ev JOIN change_requests cr ON cr.id=ev.request_id
        ORDER BY ev.at ASC`
    ).all();
    const rows=q.results as any[]; const out:string[]=[];
    out.push("\uFEFF"+["id_demande","num_commande","action","horodatage","par","motif","commentaire","details_modif","date_ouverture","date_cloture"].join(";"));
    for(const r of rows){
      let reason="",comment="",details=r.action;
      try{
        const d=r.data_json?JSON.parse(r.data_json):{};
        reason=d.reason||""; comment=d.comment||"";
        if(r.action==="UPDATED"&&d.before&&d.after){
          const diffs:string[]=[]; for(const k of ["status","reason","comment"]){ if(d.before[k]!==d.after[k]) diffs.push(`${k}:${d.before[k]}->${d.after[k]}`); }
          details=diffs.join(" | ");
        }
      }catch{}
      out.push([r.id_demande,r.num_commande,r.action,r.horodatage,r.par,reason,comment,details,r.opened_at||"",r.closed_at||""]
        .map((x:any)=>(x??"").toString().replace(/;/g,",")).join(";"));
    }
    return new Response(out.join("\n"),{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="journal_modifs.csv"'}});
  }

  return bad('Not found',404);
};
