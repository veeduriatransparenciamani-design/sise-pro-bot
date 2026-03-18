// ═══════════════════════════════════════════════════════════════════
// SISE PRO BOT — WhatsApp + Claude IA + Hoja de Vida Automática
// Servicio Público de Empleo — Maní, Casanare
// ═══════════════════════════════════════════════════════════════════

const express  = require('express');
const twilio   = require('twilio');
const axios    = require('axios');
const Database = require('better-sqlite3');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign } = require('docx');
const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── CONFIGURACIÓN ──────────────────────────────────────────────────
const CONFIG = {
  TWILIO_SID:   process.env.TWILIO_SID   || 'AC_PENDIENTE',
  TWILIO_TOKEN: process.env.TWILIO_TOKEN || 'TOKEN_PENDIENTE',
  TWILIO_WA:    process.env.TWILIO_WA    || 'whatsapp:+14155238886',
  CLAUDE_KEY:   process.env.CLAUDE_KEY   || 'sk-ant-PENDIENTE',
  PORT:         process.env.PORT         || 3000,
  PRECIO:       process.env.PRECIO       || '20000',
  NEQUI:        process.env.NEQUI        || '3156923969',
  NOMBRE_SPE:   'SPE Maní — Casanare',
};

// ── BASE DE DATOS ──────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'sise_bot.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS sesiones (
    telefono TEXT PRIMARY KEY,
    estado   TEXT DEFAULT 'inicio',
    datos    TEXT DEFAULT '{}',
    actualizado TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS hojas_de_vida (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT,
    nombre   TEXT,
    datos    TEXT,
    archivo  TEXT,
    pagado   INTEGER DEFAULT 0,
    creado   TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── CLIENTE TWILIO ─────────────────────────────────────────────────
const twilioClient = twilio(CONFIG.TWILIO_SID, CONFIG.TWILIO_TOKEN);

// ── CLAUDE IA ──────────────────────────────────────────────────────
async function llamarClaude(prompt, imagenBase64, mimeType) {
  const content = [];
  if (imagenBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imagenBase64 }
    });
  }
  content.push({ type: 'text', text: prompt });

  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content }]
  }, {
    headers: {
      'x-api-key': CONFIG.CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });
  return res.data.content[0].text.trim();
}

// ── DESCARGAR IMAGEN DE TWILIO ─────────────────────────────────────
async function descargarImagen(mediaUrl) {
  const res = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: CONFIG.TWILIO_SID, password: CONFIG.TWILIO_TOKEN }
  });
  return {
    base64: Buffer.from(res.data).toString('base64'),
    mime:   res.headers['content-type'] || 'image/jpeg'
  };
}

// ── EXTRAER DATOS DE DOCUMENTO CON IA ─────────────────────────────
async function analizarDocumento(base64, mime, tipo) {
  const prompts = {
    cedula: `Analiza este documento de identidad colombiano (puede ser CC, PPT, CE, Pasaporte).
Extrae TODOS los datos visibles. Devuelve SOLO JSON válido:
{"tipoDoc":"CC","numDoc":null,"ap1":null,"ap2":null,"nom1":null,"nom2":null,
"fechaNac":null,"genero":null,"sangre":null,"deptNac":null,"munNac":null,"nacion":"Colombiana"}
REGLAS: numDoc sin puntos. fechaNac YYYY-MM-DD. genero M/F. Si es PPT nacion=Venezolana.
SOLO el JSON, sin texto adicional.`,

    diploma: `Analiza este diploma, acta de grado o certificado académico.
Devuelve SOLO JSON:
{"nivel":null,"estado":"COM","titulo":null,"inst":null,"fin":null}
nivel: PRI/SEC/TEC/TPRO/PRE/ESP/MAS/DOC. fin: año YYYY. SOLO el JSON.`,

    laboral: `Analiza este certificado laboral o carta de trabajo colombiana.
Devuelve SOLO JSON:
{"empresa":null,"cargo":null,"tCon":"IND","tEmp":"PRI","ciudad":null,"telEmp":null,
"jefe":null,"fIng":null,"fRet":null,"tiempo":null,"tManual":null,"sinF":false,
"funciones":null,"salario":null,"motivoRet":null}
fIng/fRet: YYYY-MM-DD. Si no hay fechas: sinF=true, tManual="X meses". SOLO el JSON.`,

    curso: `Analiza este certificado de curso, taller o capacitación.
Devuelve SOLO JSON:
{"tipo":"CUR","nombre":null,"inst":null,"anio":null,"horas":null,"nroCert":null}
tipo: CUR/DIP/SEM/TAL/FOR. SOLO el JSON.`
  };

  const texto = await llamarClaude(prompts[tipo] || prompts.cedula, base64, mime);
  const limpio = texto.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
  return JSON.parse(limpio);
}

// ── GENERAR WORD ────────────────────────────────────────────────────
async function generarHojaDeVida(datos) {
  const AZUL='003875', AMARILLO='FCD116', BLANCO='FFFFFF', GRIS='F5F5F5', GRIS2='EEEEEE', NEGRO='1A1A1A';
  const sinB = { style:BorderStyle.NONE, size:0, color:'FFFFFF' };
  const SB = { top:sinB, bottom:sinB, left:sinB, right:sinB };
  const b = { style:BorderStyle.SINGLE, size:1, color:'DDDDDD' };
  const BB = { top:b, bottom:b, left:b, right:b };
  const sp = (pts=120) => new Paragraph({ spacing:{before:pts,after:0}, children:[] });

  const sec = (titulo) => new Table({
    width:{size:10466,type:WidthType.DXA}, columnWidths:[10466],
    rows:[new TableRow({children:[new TableCell({
      width:{size:10466,type:WidthType.DXA},
      shading:{fill:AZUL,type:ShadingType.CLEAR}, borders:SB,
      margins:{top:100,bottom:100,left:200,right:200},
      children:[new Paragraph({children:[new TextRun({text:'  '+titulo,bold:true,color:AMARILLO,size:22,font:'Arial'})]})]
    })]})]
  });

  const fila = (label,val,bgL=GRIS,bgV=BLANCO) => {
    const mk=(txt,bold,color,bg,w)=>new TableCell({
      width:{size:w,type:WidthType.DXA}, borders:BB,
      shading:{fill:bg,type:ShadingType.CLEAR},
      margins:{top:80,bottom:80,left:150,right:150},
      verticalAlign:VerticalAlign.CENTER,
      children:[new Paragraph({children:[new TextRun({text:String(txt||''),bold,color,size:18,font:'Arial'})]})]
    });
    return new TableRow({children:[mk(label,true,AZUL,bgL,2800),mk(val,false,NEGRO,bgV,7666)]});
  };

  const nombre = [datos.nom1,datos.nom2,datos.ap1,datos.ap2].filter(Boolean).join(' ');
  const children = [];

  // Header
  children.push(new Table({
    width:{size:10466,type:WidthType.DXA}, columnWidths:[7500,2966],
    rows:[new TableRow({children:[
      new TableCell({
        width:{size:7500,type:WidthType.DXA},
        shading:{fill:AZUL,type:ShadingType.CLEAR}, borders:SB,
        margins:{top:200,bottom:200,left:300,right:300}, verticalAlign:VerticalAlign.CENTER,
        children:[
          new Paragraph({children:[new TextRun({text:nombre||'ASPIRANTE',bold:true,color:BLANCO,size:30,font:'Arial'})]}),
          new Paragraph({spacing:{before:80},children:[new TextRun({text:`${datos.tipoDoc||'CC'}: ${datos.numDoc||''}  •  ${datos.nacion||'Colombiana'}`,color:AMARILLO,size:18,font:'Arial'})]}),
          new Paragraph({spacing:{before:60},children:[new TextRun({text:`📱 ${datos.celular||''}  •  ✉ ${datos.correo||''}`,color:'CCDDFF',size:18,font:'Arial'})]})
        ]
      }),
      new TableCell({
        width:{size:2966,type:WidthType.DXA},
        shading:{fill:AZUL,type:ShadingType.CLEAR}, borders:SB,
        margins:{top:200,bottom:200,left:200,right:200}, verticalAlign:VerticalAlign.CENTER,
        children:[
          new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'🇨🇴 SPE Colombia',bold:true,color:AMARILLO,size:18,font:'Arial'})]}),
          new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'Servicio Público de Empleo',color:BLANCO,size:16,font:'Arial'})]}),
          new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:40},children:[new TextRun({text:'Maní, Casanare',color:'CCDDFF',size:14,font:'Arial'})]})
        ]
      })
    ]})]
  }));

  // Datos personales
  children.push(sp(200), sec('👤  DATOS PERSONALES'), sp(80));
  const rowsDatos = [
    ['Tipo de Documento', datos.tipoDoc==='PPT'?'PPT — Permiso por Protección Temporal':datos.tipoDoc||'CC'],
    ['Número de Documento', datos.numDoc||''],
    ['Fecha de Nacimiento', datos.fechaNac||''],
    ['Género', datos.genero==='M'?'Masculino':'Femenino'],
    ['Grupo Sanguíneo', datos.sangre||'Sin información'],
    ['Nacionalidad', datos.nacion||'Colombiana'],
    ['Lugar de Nacimiento', [datos.munNac,datos.deptNac].filter(Boolean).join(', ')||'Sin información'],
    ['Dirección', datos.direccion||'Sin información'],
    ['Celular', datos.celular||''],
    ['Correo Electrónico', datos.correo||''],
  ];
  children.push(new Table({
    width:{size:10466,type:WidthType.DXA}, columnWidths:[2800,7666],
    rows: rowsDatos.map((([l,v],i)=>fila(l,v,i%2===0?GRIS:GRIS2)))
  }));

  // Educación
  if (datos.educacion && datos.educacion.length > 0) {
    children.push(sp(200), sec('🎓  EDUCACIÓN'), sp(80));
    datos.educacion.forEach((ed, i) => {
      const niveles = {PRI:'Primaria',SEC:'Bachillerato',TEC:'Técnico',TPRO:'Tecnólogo',PRE:'Universitario',ESP:'Especialización',MAS:'Maestría',DOC:'Doctorado'};
      const estados = {COM:'Graduado',INC:'Incompleto',CUR:'En curso'};
      children.push(new Table({
        width:{size:10466,type:WidthType.DXA}, columnWidths:[2800,7666],
        rows:[
          new TableRow({children:[new TableCell({
            columnSpan:2, width:{size:10466,type:WidthType.DXA},
            shading:{fill:'E8EEF6',type:ShadingType.CLEAR}, borders:BB,
            margins:{top:80,bottom:80,left:150,right:150},
            children:[new Paragraph({children:[
              new TextRun({text:`Estudio ${i+1}: `,bold:true,color:AZUL,size:20,font:'Arial'}),
              new TextRun({text:`${ed.titulo||''} — ${ed.inst||''}`,bold:true,color:NEGRO,size:20,font:'Arial'})
            ]})]
          })]})],
        rows:[
          fila('Nivel', niveles[ed.nivel]||ed.nivel||''),
          fila('Título', ed.titulo||'', GRIS2),
          fila('Institución', ed.inst||''),
          fila('Estado', estados[ed.estado]||ed.estado||'Graduado', GRIS2),
          fila('Año de Grado', ed.fin||''),
        ]
      }), sp(80));
    });
  }

  // Experiencia
  if (datos.experiencia && datos.experiencia.length > 0) {
    children.push(sp(200), sec('🏢  EXPERIENCIA LABORAL'), sp(80));
    datos.experiencia.forEach((exp, i) => {
      children.push(new Table({
        width:{size:10466,type:WidthType.DXA}, columnWidths:[2800,7666],
        rows:[
          new TableRow({children:[new TableCell({
            columnSpan:2, width:{size:10466,type:WidthType.DXA},
            shading:{fill:'E8EEF6',type:ShadingType.CLEAR}, borders:BB,
            margins:{top:80,bottom:80,left:150,right:150},
            children:[new Paragraph({children:[
              new TextRun({text:`Empleo ${i+1}: `,bold:true,color:AZUL,size:20,font:'Arial'}),
              new TextRun({text:`${exp.cargo||''} — ${exp.empresa||''}`,bold:true,color:NEGRO,size:20,font:'Arial'})
            ]})]
          })]})],
          fila('Empresa', exp.empresa||''),
          fila('Cargo', exp.cargo||'', GRIS2),
          fila('Tipo de Empresa', {PRI:'Privada',PUB:'Pública',MIX:'Mixta'}[exp.tEmp]||'Privada'),
          fila('Tipo de Contrato', {IND:'Término Indefinido',FIJ:'Término Fijo',OBR:'Obra/Labor',PS:'Prestación de Servicios'}[exp.tCon]||'', GRIS2),
          fila('Ciudad', exp.ciudad||''),
          fila('Período', exp.sinF ? (exp.tManual||'') : `${exp.fIng||''} — ${exp.fRet||'Actualidad'}`, GRIS2),
          fila('Duración', exp.tiempo||exp.tManual||''),
          fila('Jefe Inmediato', exp.jefe||'', GRIS2),
          fila('Tel. Empresa', exp.telEmp||''),
          fila('Funciones', exp.funciones||'', GRIS2),
        ]
      }), sp(80));
    });
  }

  // Capacitaciones
  if (datos.capacitacion && datos.capacitacion.length > 0) {
    children.push(sp(200), sec('📚  CAPACITACIONES'), sp(80));
    datos.capacitacion.forEach((cap, i) => {
      children.push(new Table({
        width:{size:10466,type:WidthType.DXA}, columnWidths:[2800,7666],
        rows:[
          fila('Curso/Diplomado', cap.nombre||''),
          fila('Institución', cap.inst||'', GRIS2),
          fila('Año', cap.anio||''),
          fila('Horas', cap.horas||'', GRIS2),
        ]
      }), sp(80));
    });
  }

  // Firma
  children.push(sp(200), sec('✍️  FIRMA Y DECLARACIÓN'), sp(80));
  children.push(new Table({
    width:{size:10466,type:WidthType.DXA}, columnWidths:[5233,5233],
    rows:[new TableRow({children:[
      new TableCell({
        width:{size:5233,type:WidthType.DXA}, borders:BB,
        shading:{fill:GRIS,type:ShadingType.CLEAR},
        margins:{top:200,bottom:200,left:200,right:200},
        children:[
          new Paragraph({spacing:{before:200},alignment:AlignmentType.CENTER,children:[new TextRun({text:'_________________________',color:'888888',size:20,font:'Arial'})]}),
          new Paragraph({spacing:{before:80},alignment:AlignmentType.CENTER,children:[new TextRun({text:nombre,bold:true,color:AZUL,size:18,font:'Arial'})]}),
          new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:`${datos.tipoDoc||'CC'} ${datos.numDoc||''}`,color:'555555',size:16,font:'Arial'})]})
        ]
      }),
      new TableCell({
        width:{size:5233,type:WidthType.DXA}, borders:BB,
        shading:{fill:BLANCO,type:ShadingType.CLEAR},
        margins:{top:150,bottom:150,left:200,right:200},
        children:[
          new Paragraph({children:[new TextRun({text:'Declaración de Veracidad',bold:true,color:AZUL,size:18,font:'Arial'})]}),
          new Paragraph({spacing:{before:60},children:[new TextRun({text:'Declaro que la información es verídica. Autorizo al SPE a verificar mis datos conforme a la Ley 1581 de 2012.',color:NEGRO,size:16,font:'Arial'})]}),
          new Paragraph({spacing:{before:80},children:[new TextRun({text:'Fecha: '+new Date().toLocaleDateString('es-CO'),color:'666666',size:16,font:'Arial'})]})
        ]
      })
    ]})]
  }));

  // Footer
  children.push(sp(150));
  children.push(new Table({
    width:{size:10466,type:WidthType.DXA}, columnWidths:[10466],
    rows:[new TableRow({children:[new TableCell({
      width:{size:10466,type:WidthType.DXA},
      shading:{fill:AZUL,type:ShadingType.CLEAR}, borders:SB,
      margins:{top:100,bottom:100,left:200,right:200},
      children:[new Paragraph({alignment:AlignmentType.CENTER,children:[
        new TextRun({text:'Generado con SISE PRO  •  Servicio Público de Empleo Colombia  •  Maní, Casanare  •  '+new Date().toLocaleDateString('es-CO'),color:'AABBDD',size:16,font:'Arial'})
      ]})]
    })]})]
  }));

  const doc = new Document({
    sections:[{ properties:{page:{size:{width:11906,height:16838},margin:{top:720,right:720,bottom:720,left:720}}}, children }]
  });

  const buf = await Packer.toBuffer(doc);
  const archivo = path.join(__dirname, 'hvs', `HV_${datos.numDoc}_${Date.now()}.docx`);
  if(!fs.existsSync(path.join(__dirname,'hvs'))) fs.mkdirSync(path.join(__dirname,'hvs'));
  fs.writeFileSync(archivo, buf);
  return archivo;
}

// ── ENVIAR MENSAJE WHATSAPP ────────────────────────────────────────
async function enviarMensaje(para, mensaje, mediaUrl=null) {
  const opts = { from: CONFIG.TWILIO_WA, to: para, body: mensaje };
  if (mediaUrl) opts.mediaUrl = [mediaUrl];
  try { await twilioClient.messages.create(opts); } catch(e) { console.error('Error enviando:', e.message); }
}

// ── LÓGICA DEL BOT ─────────────────────────────────────────────────
async function procesarMensaje(telefono, mensaje, mediaUrl, mediaType) {
  // Cargar sesión
  let sesion = db.prepare('SELECT * FROM sesiones WHERE telefono=?').get(telefono);
  if (!sesion) {
    db.prepare('INSERT INTO sesiones(telefono) VALUES(?)').run(telefono);
    sesion = { telefono, estado:'inicio', datos:'{}' };
  }
  let estado = sesion.estado;
  let datos  = JSON.parse(sesion.datos || '{}');
  const msg  = (mensaje||'').trim().toLowerCase();

  // ── INICIO ────────────────────────────────────────────────────────
  if (estado === 'inicio' || msg === 'hola' || msg === 'inicio' || msg === 'menu') {
    estado = 'menu';
    await enviarMensaje(telefono,
      `👋 ¡Bienvenido al *${CONFIG.NOMBRE_SPE}*!\n\n` +
      `Soy el asistente IA de Hojas de Vida 🤖\n\n` +
      `Le ayudo a crear su hoja de vida profesional en minutos.\n\n` +
      `*¿Qué desea hacer?*\n\n` +
      `1️⃣ Crear mi Hoja de Vida\n` +
      `2️⃣ Ver el costo del servicio\n` +
      `3️⃣ Hablar con un asesor\n\n` +
      `Responda con el número de su opción.`
    );
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── MENÚ ──────────────────────────────────────────────────────────
  if (estado === 'menu') {
    if (msg === '1' || msg.includes('crear') || msg.includes('hoja')) {
      estado = 'esperando_cedula';
      datos  = {};
      await enviarMensaje(telefono,
        `✅ *¡Perfecto! Vamos a crear su hoja de vida.*\n\n` +
        `📋 *PASO 1 de 5*\n\n` +
        `📷 Por favor tome una foto a su *Cédula de Ciudadanía* (o PPT si es venezolano) *por ambas caras* y envíela aquí.\n\n` +
        `_La IA leerá automáticamente todos sus datos_`
      );
    } else if (msg === '2' || msg.includes('costo') || msg.includes('precio')) {
      await enviarMensaje(telefono,
        `💰 *Costo del servicio:*\n\n` +
        `📄 Hoja de Vida básica: *$${CONFIG.PRECIO} COP*\n\n` +
        `✅ Incluye:\n• Diseño profesional\n• Formato Word\n• 4 estilos diferentes\n• Entrega inmediata\n\n` +
        `Pago por *Nequi o Daviplata* al ${CONFIG.NEQUI}\n\n` +
        `¿Desea crearla? Responda *1* para comenzar.`
      );
    } else if (msg === '3') {
      await enviarMensaje(telefono,
        `📞 Para hablar con un asesor llame o escriba a:\n*${CONFIG.NEQUI}*\n\nHorario: Lunes a Viernes 8am - 5pm`
      );
    }
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── CÉDULA ────────────────────────────────────────────────────────
  if (estado === 'esperando_cedula') {
    if (mediaUrl) {
      await enviarMensaje(telefono, '⏳ Leyendo su documento de identidad...');
      try {
        const { base64, mime } = await descargarImagen(mediaUrl);
        const resultado = await analizarDocumento(base64, mime, 'cedula');
        Object.assign(datos, resultado);
        const nombre = [resultado.nom1,resultado.nom2,resultado.ap1,resultado.ap2].filter(Boolean).join(' ');
        estado = 'confirmar_cedula';
        await enviarMensaje(telefono,
          `✅ *Documento leído correctamente:*\n\n` +
          `👤 Nombre: *${nombre}*\n` +
          `🪪 ${resultado.tipoDoc}: *${resultado.numDoc}*\n` +
          `🎂 Fecha nac: *${resultado.fechaNac}*\n` +
          `🩸 Sangre: *${resultado.sangre||'No visible'}*\n` +
          `📍 Nació en: *${resultado.munNac||''}, ${resultado.deptNac||''}*\n\n` +
          `¿Los datos son correctos?\n*SI* para continuar\n*NO* para reenviar la foto`
        );
      } catch(e) {
        await enviarMensaje(telefono,
          `❌ No pude leer el documento.\n\nIntente con:\n• Mejor iluminación\n• La foto más enfocada\n• Toda la cédula visible`
        );
      }
    } else {
      await enviarMensaje(telefono, '📷 Por favor envíe una *foto* de su documento de identidad (cédula o PPT).');
    }
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── CONFIRMAR CÉDULA ──────────────────────────────────────────────
  if (estado === 'confirmar_cedula') {
    if (msg === 'si' || msg === 'sí' || msg === 's' || msg === 'yes') {
      estado = 'esperando_contacto';
      await enviarMensaje(telefono,
        `✅ Perfecto.\n\n` +
        `📋 *PASO 2 de 5*\n\n` +
        `Por favor envíe su información de contacto en un solo mensaje:\n\n` +
        `📱 Celular\n📧 Correo electrónico\n🏠 Municipio donde vive\n\n` +
        `_Ejemplo: 3112345678 correo@gmail.com Maní Casanare_`
      );
    } else {
      estado = 'esperando_cedula';
      await enviarMensaje(telefono, '📷 Está bien. Envíe de nuevo la foto de su documento.');
    }
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── CONTACTO ──────────────────────────────────────────────────────
  if (estado === 'esperando_contacto') {
    // Extraer datos con Claude
    const prompt = `Extrae del siguiente texto: celular, correo electrónico, municipio y departamento.
Devuelve SOLO JSON: {"celular":null,"correo":null,"munRes":null,"deptRes":null}
Texto: "${mensaje}"`;
    try {
      const resultado = await llamarClaude(prompt, null, null);
      const limpio = resultado.replace(/^```json\s*/,'').replace(/```\s*$/,'').trim();
      const contacto = JSON.parse(limpio);
      Object.assign(datos, contacto);
    } catch(e) {
      // Si Claude falla, guardar el texto raw
      datos.contactoRaw = mensaje;
    }
    estado = 'esperando_diploma';
    await enviarMensaje(telefono,
      `✅ Datos de contacto guardados.\n\n` +
      `📋 *PASO 3 de 5*\n\n` +
      `🎓 ¿Tiene diplomas o certificados de estudio?\n\n` +
      `• Si *SÍ*: envíe la foto del diploma o acta de grado\n` +
      `• Si *NO*: responda *NO*\n\n` +
      `_Puede enviar varios diplomas uno por uno_`
    );
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── DIPLOMA ───────────────────────────────────────────────────────
  if (estado === 'esperando_diploma') {
    if (mediaUrl) {
      await enviarMensaje(telefono, '⏳ Leyendo su diploma...');
      try {
        const { base64, mime } = await descargarImagen(mediaUrl);
        const resultado = await analizarDocumento(base64, mime, 'diploma');
        if (!datos.educacion) datos.educacion = [];
        datos.educacion.push(resultado);
        await enviarMensaje(telefono,
          `✅ *Diploma leído:*\n` +
          `🎓 ${resultado.titulo||''}\n` +
          `🏫 ${resultado.inst||''}\n\n` +
          `¿Tiene otro diploma? Envíelo o responda *LISTO* para continuar.`
        );
      } catch(e) {
        await enviarMensaje(telefono, `❌ No pude leer el diploma. Intente con mejor iluminación o responda *LISTO* para continuar.`);
      }
    } else if (msg === 'no' || msg === 'listo' || msg === 'siguiente') {
      estado = 'esperando_laboral';
      await enviarMensaje(telefono,
        `📋 *PASO 4 de 5*\n\n` +
        `💼 ¿Tiene certificados laborales o cartas de trabajo?\n\n` +
        `• Si *SÍ*: envíe la foto del certificado\n` +
        `• Si *NO*: responda *NO*\n\n` +
        `_Puede enviar varios certificados uno por uno_`
      );
    }
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── LABORAL ───────────────────────────────────────────────────────
  if (estado === 'esperando_laboral') {
    if (mediaUrl) {
      await enviarMensaje(telefono, '⏳ Leyendo su certificado laboral...');
      try {
        const { base64, mime } = await descargarImagen(mediaUrl);
        const resultado = await analizarDocumento(base64, mime, 'laboral');
        if (!datos.experiencia) datos.experiencia = [];
        datos.experiencia.push(resultado);
        await enviarMensaje(telefono,
          `✅ *Certificado laboral leído:*\n` +
          `🏢 ${resultado.empresa||''}\n` +
          `💼 ${resultado.cargo||''}\n` +
          `⏱ ${resultado.tiempo||resultado.tManual||''}\n\n` +
          `¿Tiene otro certificado laboral? Envíelo o responda *LISTO* para continuar.`
        );
      } catch(e) {
        await enviarMensaje(telefono, `❌ No pude leer el certificado. Intente de nuevo o responda *LISTO*.`);
      }
    } else if (msg === 'no' || msg === 'listo' || msg === 'siguiente') {
      estado = 'esperando_cargo';
      await enviarMensaje(telefono,
        `📋 *PASO 5 de 5 — ¡Ya casi terminamos!*\n\n` +
        `💼 ¿Cuál es el *cargo* al que aspira trabajar?\n\n` +
        `_Ejemplo: Operario de campo, Auxiliar administrativo, Conductor..._`
      );
    }
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── CARGO DESEADO ─────────────────────────────────────────────────
  if (estado === 'esperando_cargo') {
    datos.cargoDeseado = mensaje.toUpperCase();
    estado = 'generando';
    await enviarMensaje(telefono,
      `⏳ *Generando su hoja de vida profesional...*\n\n` +
      `Esto tarda unos segundos 🤖✨`
    );

    try {
      const archivo = await generarHojaDeVida(datos);
      const nombre = [datos.nom1,datos.ap1].filter(Boolean).join(' ');

      // Guardar en BD
      db.prepare('INSERT INTO hojas_de_vida(telefono,nombre,datos,archivo) VALUES(?,?,?,?)')
        .run(telefono, nombre, JSON.stringify(datos), archivo);

      estado = 'esperando_pago';
      await enviarMensaje(telefono,
        `✅ *¡Su hoja de vida está lista, ${nombre}!*\n\n` +
        `Para recibirla realice el pago de:\n\n` +
        `💰 *$${CONFIG.PRECIO} COP*\n\n` +
        `📱 *Nequi o Daviplata*\n` +
        `📞 Número: *${CONFIG.NEQUI}*\n\n` +
        `Cuando realice el pago, envíe aquí el *comprobante* y le envío su hoja de vida inmediatamente. 📄`
      );
    } catch(e) {
      console.error('Error generando HV:', e);
      await enviarMensaje(telefono, `❌ Ocurrió un error generando su hoja de vida. Por favor escriba *hola* para intentar de nuevo.`);
      estado = 'inicio';
    }
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── ESPERANDO PAGO ────────────────────────────────────────────────
  if (estado === 'esperando_pago') {
    if (mediaUrl) {
      // El cliente envía comprobante de pago
      await enviarMensaje(telefono, '⏳ Verificando comprobante de pago...');

      // Marcar como pagado
      db.prepare('UPDATE hojas_de_vida SET pagado=1 WHERE telefono=? ORDER BY creado DESC LIMIT 1').run(telefono);

      // Obtener archivo
      const hv = db.prepare('SELECT * FROM hojas_de_vida WHERE telefono=? ORDER BY creado DESC LIMIT 1').get(telefono);

      if (hv && hv.archivo && fs.existsSync(hv.archivo)) {
        // Subir archivo a Twilio y enviar
        // Por ahora enviamos confirmación (el archivo Word requiere hosting)
        await enviarMensaje(telefono,
          `✅ *¡Pago verificado! Gracias.*\n\n` +
          `📄 Su hoja de vida ha sido enviada exitosamente.\n\n` +
          `El documento Word profesional llegará en los próximos minutos.\n\n` +
          `¡Mucho éxito en su búsqueda de empleo! 🌟\n\n` +
          `Para crear otra hoja de vida escriba *hola*`
        );
        estado = 'inicio';
      }
    } else {
      await enviarMensaje(telefono,
        `📷 Por favor envíe la *foto del comprobante* de pago de $${CONFIG.PRECIO} COP a Nequi/Daviplata ${CONFIG.NEQUI}\n\n` +
        `Para cancelar y empezar de nuevo escriba *hola*`
      );
    }
    guardarSesion(telefono, estado, datos);
    return;
  }

  // ── MENSAJE NO RECONOCIDO ─────────────────────────────────────────
  await enviarMensaje(telefono,
    `No entendí su mensaje 😅\n\n` +
    `Escriba *hola* para volver al menú principal.`
  );
}

function guardarSesion(telefono, estado, datos) {
  db.prepare(`INSERT INTO sesiones(telefono,estado,datos,actualizado)
    VALUES(?,?,?,datetime('now','localtime'))
    ON CONFLICT(telefono) DO UPDATE SET estado=excluded.estado,
    datos=excluded.datos, actualizado=excluded.actualizado`)
    .run(telefono, estado, JSON.stringify(datos));
}

// ── SERVIDOR EXPRESS ───────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Webhook de Twilio
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Twilio
  const telefono  = req.body.From;
  const mensaje   = req.body.Body || '';
  const mediaUrl  = req.body.MediaUrl0 || null;
  const mediaType = req.body.MediaContentType0 || null;
  if (!telefono) return;
  try {
    await procesarMensaje(telefono, mensaje, mediaUrl, mediaType);
  } catch(e) {
    console.error('Error en webhook:', e.message);
  }
});

// Panel de estado
app.get('/', (req, res) => {
  const total   = db.prepare('SELECT COUNT(*) as n FROM hojas_de_vida').get().n;
  const pagadas = db.prepare('SELECT COUNT(*) as n FROM hojas_de_vida WHERE pagado=1').get().n;
  res.json({
    estado: 'SISE PRO Bot funcionando ✅',
    hvs_generadas: total,
    hvs_pagadas: pagadas,
    ingresos_cop: pagadas * parseInt(CONFIG.PRECIO)
  });
});

app.listen(CONFIG.PORT, () => {
  console.log(`\n✅ SISE PRO Bot corriendo en puerto ${CONFIG.PORT}`);
  console.log(`📱 Webhook: http://TU_URL:${CONFIG.PORT}/webhook`);
  console.log(`📊 Panel:   http://TU_URL:${CONFIG.PORT}/\n`);
});
