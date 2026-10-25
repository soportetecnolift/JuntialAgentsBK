/**
 * Plantillas de puesto: cualquier empresa puede "contratar" un empleado digital en minutos y ajustarlo.
 * Cada una trae misión, responsabilidades, objetivos, rutinas y un nivel de autonomía de partida.
 */
export const AUTONOMY_PRESETS = {
  observador: { label: 'Observador', desc: 'Solo lee, analiza e informa. No cambia nada.', policy: { read: 'auto', internal: 'auto', data: 'off', external: 'off', destructive: 'off' } },
  asistente: { label: 'Asistente', desc: 'Lee e informa solo; propone cambios y mensajes para que los apruebes.', policy: { read: 'auto', internal: 'auto', data: 'approve', external: 'approve', destructive: 'off' } },
  colaborador: { label: 'Colaborador', desc: 'Actualiza datos por su cuenta; pide aprobación para hablar con clientes o borrar.', policy: { read: 'auto', internal: 'auto', data: 'auto', external: 'approve', destructive: 'approve' } },
  autonomo: { label: 'Autónomo', desc: 'Trabaja solo, incluso con clientes. Solo pide aprobación para acciones irreversibles.', policy: { read: 'auto', internal: 'auto', data: 'auto', external: 'auto', destructive: 'approve' } },
};
export const CATEGORIES = {
  read: { label: 'Consultar información', desc: 'Leer el CRM, buscar en conectores, consultar documentos.' },
  internal: { label: 'Avisar y organizarse', desc: 'Informarte, guardar notas, programarse seguimientos.' },
  data: { label: 'Cambiar datos', desc: 'Crear o actualizar registros en el CRM o en tus aplicaciones.' },
  external: { label: 'Comunicarse con clientes', desc: 'Enviar emails o mensajes a personas de fuera.' },
  destructive: { label: 'Acciones irreversibles', desc: 'Borrar, anular, cancelar, reembolsar.' },
};
export const ROLES = {
  comercial: {
    label: 'Comercial · seguimiento de leads', icon: '📈', preset: 'asistente',
    title: 'Responsable de seguimiento comercial',
    mission: 'Que ningún lead ni oportunidad se enfríe: detectar contactos sin seguimiento, priorizarlos y preparar el siguiente paso.',
    responsibilities: '- Revisar a diario los contactos nuevos y los que llevan días sin actividad.\n- Cualificar leads según presupuesto, necesidad y urgencia.\n- Preparar mensajes de seguimiento personalizados.\n- Avisar de las oportunidades calientes.',
    kpis: '- 0 leads nuevos sin respuesta en más de 24 h.\n- Tiempo medio de primer contacto < 2 h laborables.',
    routines: [
      { name: 'Revisión matinal de leads', cron: '0 9 * * 1-5', instruction: 'Revisa los contactos en estado Nuevo y los que no se han actualizado en 3 días. Prioriza por potencial, propone el siguiente paso de cada uno y prepara los mensajes de seguimiento.' },
      { name: 'Informe semanal comercial', cron: '0 17 * * 5', instruction: 'Prepara el resumen semanal: leads nuevos, cualificados, ganados y perdidos, y las 3 oportunidades más importantes para la semana que viene.' },
    ],
  },
  soporte: {
    label: 'Soporte · atención y calidad', icon: '🛟', preset: 'colaborador',
    title: 'Coordinador de atención al cliente',
    mission: 'Garantizar que cada cliente reciba respuesta y solución a tiempo, detectando casos atascados antes de que se quejen.',
    responsibilities: '- Vigilar conversaciones que pidieron una persona y siguen sin respuesta.\n- Clasificar incidencias por urgencia.\n- Preparar respuestas tipo y escalar lo crítico.',
    kpis: '- Ninguna derivación sin atender más de 2 h.\n- Incidencias urgentes escaladas en < 15 min.',
    routines: [{ name: 'Control de casos abiertos', cron: '0 */2 * * 1-5', instruction: 'Revisa los contactos con incidencias abiertas o que pidieron hablar con una persona. Escala los urgentes y propone la respuesta para el resto.' }],
  },
  finanzas: {
    label: 'Administración · cobros y facturas', icon: '💶', preset: 'asistente',
    title: 'Asistente de administración y cobros',
    mission: 'Reducir los impagos y los retrasos: vigilar vencimientos, preparar recordatorios y mantener al día la información de facturación.',
    responsibilities: '- Revisar facturas vencidas o que vencen esta semana.\n- Preparar recordatorios de cobro con el tono adecuado.\n- Avisar de clientes con riesgo de impago.',
    kpis: '- Recordatorio enviado el día del vencimiento.\n- Días medios de cobro a la baja.',
    routines: [
      { name: 'Revisión de vencimientos', cron: '0 10 * * 1-5', instruction: 'Consulta en los conectores las facturas vencidas y las que vencen en los próximos 7 días. Prepara un recordatorio para cada cliente y avísame de los importes más altos.' },
      { name: 'Cierre de mes', cron: '0 9 1 * *', instruction: 'Prepara el resumen del mes anterior: facturado, cobrado, pendiente y clientes con más deuda.' },
    ],
  },
  operaciones: {
    label: 'Operaciones · proyectos y plazos', icon: '🏗️', preset: 'asistente',
    title: 'Coordinador de operaciones',
    mission: 'Que los proyectos avancen según lo previsto: detectar retrasos, bloqueos y tareas sin responsable.',
    responsibilities: '- Revisar el estado de proyectos y fechas comprometidas.\n- Detectar retrasos y proponer acciones.\n- Recordar a cada responsable lo que tiene pendiente.',
    kpis: '- Retrasos detectados antes de la fecha de entrega.\n- Ninguna tarea crítica sin responsable.',
    routines: [{ name: 'Parte diario de operaciones', cron: '30 8 * * 1-5', instruction: 'Revisa los proyectos y tareas con fecha en los próximos 7 días o vencida. Señala retrasos y bloqueos y propone qué hacer con cada uno.' }],
  },
  asistente: {
    label: 'Asistente de dirección', icon: '🧭', preset: 'observador',
    title: 'Asistente de dirección',
    mission: 'Darte cada día una visión clara del negocio y avisarte solo de lo que necesita tu atención.',
    responsibilities: '- Preparar el resumen diario de lo importante.\n- Detectar anomalías (caídas de actividad, picos, riesgos).\n- Recordarte decisiones pendientes.',
    kpis: '- Resumen diario antes de las 9:00.',
    routines: [{ name: 'Resumen ejecutivo diario', cron: '0 8 * * 1-5', instruction: 'Prepara mi resumen del día: qué ha pasado desde ayer en el CRM y los conectores, qué requiere mi atención hoy y qué decisiones tengo pendientes.' }],
  },
  personalizado: { label: 'Puesto personalizado', icon: '✨', preset: 'asistente', title: 'Empleado digital', mission: '', responsibilities: '', kpis: '', routines: [] },
};
