// Robot Libro de Sueldos Digital (ARCA) - carga de un empleador por pedido.
// POST /cargar  (multipart/form-data)
//   campos: cuit, periodo (MM/AAAA), prima, costo_emision, provincia, nro_liquidacion, tipo_liquidacion
//   archivo: txt
// Header requerido: X-Api-Key = ROBOT_API_KEY
// Variables de entorno en Render: ROBOT_API_KEY, ARCA_CUIT, ARCA_CLAVE

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const upload = multer({ dest: os.tmpdir() });
const { ROBOT_API_KEY, ARCA_CUIT, ARCA_CLAVE, PORT = 10000 } = process.env;

let ocupado = false;

app.get('/', (_req, res) => res.json({ ok: true, ocupado }));

app.post('/cargar', upload.single('txt'), async (req, res) => {
  if (req.get('X-Api-Key') !== ROBOT_API_KEY) return res.status(401).json({ estado: 'ERROR', detalle: 'API key invalida' });
  if (ocupado) return res.status(409).json({ estado: 'OCUPADO', detalle: 'Hay otra carga en curso' });
  if (!req.file) return res.status(400).json({ estado: 'ERROR', detalle: 'Falta el archivo txt' });

  ocupado = true;
  const pasos = [];
  const avisos = [];
  let browser;
  const txtPath = path.join(os.tmpdir(), 'LibroSueldoDigital01.txt');
  fs.renameSync(req.file.path, txtPath);

  try {
    const p = {
      cuit: String(req.body.cuit).replace(/\D/g, ''),
      periodo: req.body.periodo,
      prima: String(req.body.prima),
      costo: String(req.body.costo_emision || '0'),
      provincia: req.body.provincia || 'BUENOS AIRES',
      nroLiq: String(req.body.nro_liquidacion || '1'),
      tipoLiq: req.body.tipo_liquidacion || 'Mensual',
    };
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ locale: 'es-AR', acceptDownloads: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45000);
    let lsdRef = null;
    const paso = async (nombre, fn) => {
      pasos.push(nombre);
      if (lsdRef) await cerrarModales(lsdRef, avisos);
      await fn();
      if (lsdRef) await cerrarModales(lsdRef, avisos);
    };

    await paso('login', async () => {
      await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml');
      await page.fill('#F1\\:username', ARCA_CUIT);
      await page.click('#F1\\:btnSiguiente');
      await page.fill('#F1\\:password', ARCA_CLAVE);
      await page.click('#F1\\:btnIngresar');
      await page.waitForLoadState('networkidle');
      if (await page.locator('text=/captcha|clave incorrecta/i').count()) throw new Error('ARCA pidio captcha o rechazo la clave');
    });

    let lsd;
    await paso('abrir_servicio', async () => {
      await page.goto('https://portalcf.cloud.afip.gob.ar/portal/app/mis-servicios');
      await page.waitForLoadState('networkidle');
      const buscador = page.locator('input[placeholder*="Buscar" i]').first();
      if (await buscador.count()) await buscador.fill('Libro de Sueldos');
      const [nueva] = await Promise.all([
        ctx.waitForEvent('page'),
        page.locator('text=/Libro de Sueldos Digital/i').first().click(),
      ]);
      lsd = nueva;
      lsdRef = lsd;
      lsd.setDefaultTimeout(45000);
      await lsd.waitForLoadState('networkidle');
    });

    await paso('elegir_empleador', async () => {
      const actual = ((await lsd.locator('#ctl00_lblCuit, .lblCuit').first().textContent().catch(() => '')) || '').replace(/\D/g, '');
      if (actual === p.cuit) return;
      const sel = lsd.locator('select').first();
      if (await sel.count()) {
        const opt = await sel.locator('option').evaluateAll((os, c) => {
          const o = os.find(x => x.textContent.replace(/\D/g, '').includes(c));
          return o ? o.value : null;
        }, p.cuit);
        if (!opt) throw new Error('SIN_ACCESO: el CUIT ' + p.cuit + ' no esta delegado a tu clave fiscal');
        await sel.selectOption(opt);
        await lsd.locator('input[type=submit], button').filter({ hasText: /continuar|aceptar|ingresar/i }).first().click();
      } else {
        const link = lsd.locator('a, input[type=submit], input[type=button], td, li').filter({ hasText: p.cuit }).filter({ hasNot: lsd.locator('.lblCuit') }).last();
        if (!(await link.count())) throw new Error('SIN_ACCESO: el CUIT ' + p.cuit + ' no esta delegado a tu clave fiscal');
        await link.click();
      }
      await lsd.waitForLoadState('networkidle');
      await cerrarModales(lsd, avisos);
      const ahora = ((await lsd.locator('#ctl00_lblCuit, .lblCuit').first().textContent().catch(() => '')) || '').replace(/\D/g, '');
      if (ahora !== p.cuit) throw new Error('No se pudo seleccionar el empleador ' + p.cuit + ' (encabezado muestra ' + (ahora || 'nada') + ')');
    });

    await paso('menu_liquidaciones', async () => {
      await lsd.locator('a', { hasText: /Liquidaciones y DDJJ/i }).first().click();
      await lsd.waitForLoadState('networkidle');
    });

    await paso('nuevo_periodo', async () => {
      const existe = await lsd.locator('td', { hasText: p.periodo }).count();
      if (existe) { await lsd.locator('tr', { hasText: p.periodo }).first().locator('a, input[type=image], button').first().click(); return; }
      await lsd.locator('input, a, button').filter({ hasText: /Nuevo Per[ií]odo/i }).first().click()
        .catch(() => lsd.locator('input[value*="Nuevo" i]').first().click());
      await lsd.waitForLoadState('networkidle');
      const [mes, anio] = p.periodo.split('/');
      await fillPorEtiqueta(lsd, /Per[ií]odo/i, anio + mes, p.periodo);
      await elegirPorEtiqueta(lsd, /SCVO|Seguro Colectivo/i, /^S[IÍ]/i);
      await fillPorEtiqueta(lsd, /Prima/i, p.prima);
      await fillPorEtiqueta(lsd, /Costo.*Emisi[oó]n/i, p.costo);
      await clickBoton(lsd, /Aceptar|Guardar|Confirmar/i);
    });

    await paso('agregar_liquidacion', async () => {
      await clickBoton(lsd, /Agregar Liquidaci[oó]n/i);
      await fillPorEtiqueta(lsd, /N[uú]mero|Nro/i, p.nroLiq);
      await elegirPorEtiqueta(lsd, /Tipo/i, new RegExp(p.tipoLiq, 'i'));
      await elegirPorEtiqueta(lsd, /Provincia|Jurisdicci[oó]n/i, new RegExp(p.provincia, 'i'));
      await clickBoton(lsd, /Aceptar|Guardar|Confirmar/i);
    });

    await paso('importar_txt', async () => {
      await clickBoton(lsd, /Importar/i);
      await lsd.locator('input[type=file]').first().setInputFiles(txtPath);
      const subir = lsd.locator('input, button, a').filter({ hasText: /Subir/i });
      if (await subir.count()) await subir.first().click();
      await lsd.waitForLoadState('networkidle');
      const err = await lsd.locator('.error, [class*=error], text=/error/i').first().textContent().catch(() => null);
      if (err && /error/i.test(err)) throw new Error('Error al importar: ' + err.trim());
    });

    let resultado = '';
    await paso('validar', async () => {
      await clickBoton(lsd, /VALIDAR/i);
      await lsd.waitForLoadState('networkidle');
      resultado = (await lsd.locator('body').innerText()).match(/(VALIDAD[AO][^\n]*|PENDIENTE[^\n]*|ERROR[^\n]*)/i)?.[0] || 'Validacion enviada';
    });

    const shot = await lsd.screenshot({ fullPage: true });
    res.json({ estado: 'OK', detalle: resultado + (avisos.length ? ' | Avisos ARCA: ' + avisos.join(' / ').slice(0, 300) : ''), pasos, captura_base64: shot.toString('base64') });
  } catch (e) {
    let captura = null;
    try { const pages = browser ? browser.contexts()[0].pages() : []; captura = (await pages[pages.length - 1].screenshot({ fullPage: true })).toString('base64'); } catch (_) {}
    const sinAcceso = String(e.message).startsWith('SIN_ACCESO');
    const msg = String(e.message).split('\n')[0].slice(0, 300);
    res.status(200).json({ estado: sinAcceso ? 'SIN_ACCESO' : 'ERROR', detalle: msg + (avisos.length ? ' | Avisos ARCA: ' + avisos.join(' / ').slice(0, 300) : ''), paso_fallido: pasos[pasos.length - 1], pasos, captura_base64: captura });
  } finally {
    ocupado = false;
    try { fs.unlinkSync(txtPath); } catch (_) {}
    if (browser) await browser.close();
  }
});

async function cerrarModales(page, avisos) {
  for (let i = 0; i < 5; i++) {
    const modal = page.locator('.modal.in, .modal.show, [role=dialog]:visible').first();
    if (!(await modal.count()) || !(await modal.isVisible().catch(() => false))) return;
    const txt = ((await modal.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (txt) avisos.push(txt.slice(0, 150));
    const btn = modal.locator('button, a, input[type=button], input[type=submit]').filter({ hasText: /aceptar|cerrar|continuar|entendido|ok|×/i });
    if (await btn.count()) await btn.first().click({ force: true }).catch(() => {});
    else {
      const x = modal.locator('.close, [data-dismiss=modal], [data-bs-dismiss=modal], input[value*="Aceptar" i], input[value*="Cerrar" i]');
      if (await x.count()) await x.first().click({ force: true }).catch(() => {});
      else await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(800);
  }
}

async function campoPorEtiqueta(page, re) {
  const label = page.locator('label, td, span').filter({ hasText: re }).first();
  await label.waitFor();
  const forId = await label.getAttribute('for');
  if (forId) return page.locator('#' + forId.replace(/\$/g, '\\$'));
  return label.locator('xpath=following::*[self::input or self::select][1]');
}
async function fillPorEtiqueta(page, re, valor, alternativo) {
  const c = await campoPorEtiqueta(page, re);
  const tag = await c.evaluate(n => n.tagName);
  if (tag === 'SELECT') await c.selectOption({ label: alternativo || valor }).catch(() => c.selectOption(valor));
  else { await c.fill(''); await c.fill(valor); }
}
async function elegirPorEtiqueta(page, re, opcionRe) {
  const c = await campoPorEtiqueta(page, re);
  const tag = await c.evaluate(n => n.tagName);
  if (tag === 'SELECT') {
    const v = await c.locator('option').evaluateAll((os, src) => { const r = new RegExp(src[0], src[1]); const o = os.find(x => r.test(x.textContent.trim())); return o ? o.value : null; }, [opcionRe.source, opcionRe.flags]);
    if (!v) throw new Error('Opcion no encontrada para ' + re);
    await c.selectOption(v);
  } else {
    await page.locator('label').filter({ hasText: opcionRe }).first().click();
  }
  await page.waitForLoadState('networkidle');
}
async function clickBoton(page, re) {
  const b = page.locator('button, a').filter({ hasText: re });
  if (await b.count()) await b.first().click();
  else {
    const ok = await page.locator('input[type=submit], input[type=button], input[type=image]').evaluateAll((els, src) => {
      const r = new RegExp(src[0], src[1]);
      const el = els.find(e => r.test(e.value || e.alt || e.title || ''));
      if (!el) return false; el.click(); return true;
    }, [re.source, re.flags]);
    if (!ok) throw new Error('Boton no encontrado: ' + re);
  }
  await page.waitForLoadState('networkidle');
}

app.listen(PORT, () => console.log('Robot LSD escuchando en ' + PORT));
