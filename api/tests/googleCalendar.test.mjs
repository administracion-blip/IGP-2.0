/**
 * Cliente Google Calendar: allowlist, rango temporal, modalidad y fábrica inyectable.
 * No llama a Google real: usa un doble de `events.insert/patch/delete`.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

const prevEnv = {
  GOOGLE_SA_CLIENT_EMAIL: process.env.GOOGLE_SA_CLIENT_EMAIL,
  GOOGLE_SA_PRIVATE_KEY: process.env.GOOGLE_SA_PRIVATE_KEY,
  GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS: process.env.GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS,
  GOOGLE_CALENDAR_IMPERSONATE: process.env.GOOGLE_CALENDAR_IMPERSONATE,
  GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID,
};

function restaurarEnv() {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test.afterEach(() => {
  restaurarEnv();
});

const {
  disponible,
  credencialesConfiguradas,
  emailEnDominioPermitido,
  resolverSubject,
  construirRangoTemporal,
  derivarModalidadDeEvento,
  configurarClienteCalendar,
  crearEvento,
  actualizarEvento,
  borrarEvento,
} = await import('../lib/google/calendarClient.js');

test('sin credenciales, disponible es false y crearEvento no tumba', async () => {
  delete process.env.GOOGLE_SA_CLIENT_EMAIL;
  delete process.env.GOOGLE_SA_PRIVATE_KEY;
  delete process.env.GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS;
  assert.equal(credencialesConfiguradas(), false);
  assert.equal(disponible(), false);
  const r = await crearEvento({ titulo: 'Junta', fecha: '2026-09-01', horaInicio: '10:00', horaFin: '11:00' });
  assert.equal(r.ok, false);
  assert.match(r.error || '', /no está configurado/i);
});

test('allowlist de dominio y subject (opción A)', () => {
  process.env.GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS = 'grupoparipe.com';
  process.env.GOOGLE_CALENDAR_IMPERSONATE = 'reuniones@grupoparipe.com';
  assert.equal(emailEnDominioPermitido('ana@grupoparipe.com'), true);
  assert.equal(emailEnDominioPermitido('ana@otro.com'), false);
  const ok = resolverSubject({});
  assert.equal(ok.ok, true);
  assert.equal(ok.subject, 'reuniones@grupoparipe.com');

  process.env.GOOGLE_CALENDAR_IMPERSONATE = 'fuera@evil.com';
  const malo = resolverSubject({});
  assert.equal(malo.ok, false);
});

test('construirRangoTemporal: con horas y día completo', () => {
  const conHora = construirRangoTemporal({
    fecha: '2026-09-01',
    horaInicio: '10:00',
    horaFin: '11:30',
  });
  assert.equal(conHora.start.dateTime, '2026-09-01T10:00:00');
  assert.equal(conHora.end.timeZone, 'Europe/Madrid');

  const dia = construirRangoTemporal({ fecha: '2026-09-01' });
  assert.equal(dia.start.date, '2026-09-01');
  assert.equal(dia.end.date, '2026-09-02');
});

test('derivarModalidadDeEvento: remota, presencial y mixta', () => {
  assert.deepEqual(
    derivarModalidadDeEvento({
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    }),
    { modalidad: 'remota', sala: null, meetCode: 'abc-defg-hij' },
  );
  assert.deepEqual(
    derivarModalidadDeEvento({
      attendees: [{ email: 'sala@resource.calendar.google.com', resource: true }],
    }),
    { modalidad: 'presencial', sala: 'sala@resource.calendar.google.com', meetCode: null },
  );
  const mixta = derivarModalidadDeEvento({
    attendees: [{ email: 'sala@resource.calendar.google.com', resource: true }],
    conferenceData: {
      entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz-uvwx-yz' }],
    },
  });
  assert.equal(mixta.modalidad, 'mixta');
  assert.equal(mixta.meetCode, 'xyz-uvwx-yz');
});

test('fábrica inyectable: crear / actualizar / borrar sin Google real', async () => {
  process.env.GOOGLE_SA_CLIENT_EMAIL = 'sa@x.iam.gserviceaccount.com';
  process.env.GOOGLE_SA_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n';
  process.env.GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS = 'grupoparipe.com';
  process.env.GOOGLE_CALENDAR_IMPERSONATE = 'reuniones@grupoparipe.com';

  const llamadas = [];
  const restore = configurarClienteCalendar(async () => ({
    calendarId: 'primary',
    subject: 'reuniones@grupoparipe.com',
    calendar: {
      events: {
        insert: async (args) => {
          llamadas.push(['insert', args]);
          return {
            data: {
              id: 'evt-1',
              hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc',
              conferenceData: {
                entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/aaa-bbbb-ccc' }],
              },
            },
          };
        },
        patch: async (args) => {
          llamadas.push(['patch', args]);
          return { data: { id: args.eventId, summary: args.requestBody.summary } };
        },
        delete: async (args) => {
          llamadas.push(['delete', args]);
          return {};
        },
      },
    },
  }));

  try {
    assert.equal(disponible(), true);
    const creada = await crearEvento({
      titulo: 'Comité',
      fecha: '2026-09-10',
      horaInicio: '09:00',
      horaFin: '10:00',
      descripcion: 'Orden del día',
      asistentesEmails: ['ana@grupoparipe.com'],
    });
    assert.equal(creada.ok, true);
    assert.equal(creada.eventId, 'evt-1');
    assert.equal(creada.modalidad, 'remota');
    assert.equal(creada.meetCode, 'aaa-bbbb-ccc');
    assert.equal(llamadas[0][0], 'insert');
    assert.equal(llamadas[0][1].conferenceDataVersion, 1);
    assert.equal(llamadas[0][1].sendUpdates, 'all');
    assert.equal(llamadas[0][1].requestBody.description, 'Orden del día');
    assert.deepEqual(llamadas[0][1].requestBody.attendees, [{ email: 'ana@grupoparipe.com' }]);

    const patch = await actualizarEvento('evt-1', {
      titulo: 'Comité (2)',
      fecha: '2026-09-10',
      horaInicio: '09:00',
      horaFin: '10:00',
    });
    assert.equal(patch.ok, true);
    assert.equal(llamadas[1][0], 'patch');
    assert.equal(llamadas[1][1].sendUpdates, 'all');
    assert.equal(llamadas[1][1].requestBody.attendees, undefined);

    const patchInvitados = await actualizarEvento('evt-1', {
      titulo: 'Comité (2)',
      fecha: '2026-09-10',
      horaInicio: '09:00',
      horaFin: '10:00',
      asistentesEmails: ['bea@grupoparipe.com', 'externo@otro.com'],
    });
    assert.equal(patchInvitados.ok, true);
    assert.equal(llamadas[2][0], 'patch');
    assert.equal(llamadas[2][1].sendUpdates, 'all');
    assert.deepEqual(llamadas[2][1].requestBody.attendees, [
      { email: 'bea@grupoparipe.com' },
      { email: 'externo@otro.com' },
    ]);

    const del = await borrarEvento('evt-1');
    assert.equal(del.ok, true);
    assert.equal(llamadas[3][0], 'delete');
    assert.equal(llamadas[3][1].sendUpdates, 'all');
  } finally {
    restore();
  }
});

test('crearEvento sin asistentes usa sendUpdates none', async () => {
  process.env.GOOGLE_SA_CLIENT_EMAIL = 'sa@x.iam.gserviceaccount.com';
  process.env.GOOGLE_SA_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n';
  process.env.GOOGLE_CALENDAR_DOMINIOS_PERMITIDOS = 'grupoparipe.com';
  process.env.GOOGLE_CALENDAR_IMPERSONATE = 'reuniones@grupoparipe.com';

  let argsInsert = null;
  const restore = configurarClienteCalendar(async () => ({
    calendarId: 'primary',
    subject: 'reuniones@grupoparipe.com',
    calendar: {
      events: {
        insert: async (args) => {
          argsInsert = args;
          return { data: { id: 'evt-vacio' } };
        },
        patch: async () => ({ data: {} }),
        delete: async () => ({}),
      },
    },
  }));

  try {
    const creada = await crearEvento({
      titulo: 'Sin invitados',
      fecha: '2026-09-10',
      horaInicio: '09:00',
      horaFin: '10:00',
      asistentesEmails: [],
    });
    assert.equal(creada.ok, true);
    assert.equal(argsInsert.sendUpdates, 'none');
    assert.deepEqual(argsInsert.requestBody.attendees, []);
  } finally {
    restore();
  }
});