/**
 * Configurador estructurado del empleado digital ("el guion").
 * En vez de un textarea libre, el manual se construye a partir de un ESQUEMA con secciones tipadas.
 * Esto nace de endurecer a Lucia (Coordinador de operaciones, Tecnolift) en producción: cada sección de
 * abajo corresponde a una categoría de fallo real que tuvimos que corregir a mano. El objetivo es que
 * cualquier rol, en cualquier empresa, pase por las mismas preguntas y nunca falte una pieza crítica.
 *
 * Un blueprint se guarda en bot.worker.blueprint (fuente estructurada) y se RENDERIZA a
 * bot.worker.knowledge.instructions (el texto que de verdad lee el modelo). El textarea libre de
 * "Manual del puesto" se convierte en una sección más: "notas adicionales", no en el único sitio.
 */

// Una sección vacía no se renderiza: así el manual no se llena de encabezados "Sin definir".
const block = (title, body) => (body && String(body).trim() ? `# ${title}\n${String(body).trim()}` : '');
const list = (items, fmt = (x) => x) => (items || []).filter(Boolean).map((x) => `- ${fmt(x)}`).join('\n');

export const BLUEPRINT_SECTIONS = {
  context: { label: 'Contexto del negocio', help: 'Quién es la empresa, en qué sistema trabaja y dónde empieza y termina su ámbito. Sin esto, el modelo no sabe qué datos son relevantes y puede opinar fuera de su terreno.' },
  variants: { label: 'Variantes o familias que debe distinguir', help: 'Si tu proceso trata distinto según el tipo de producto, cliente o canal (fabricación propia vs. proveedor externo; B2B vs. B2C…), decláralo aquí con sus reglas propias. Si no lo declaras, el empleado aplicará la misma regla a todo y fallará en los casos especiales — esto es exactamente lo que le pasó a Lucia con Stiltz.' },
  stages: { label: 'Fases del proceso y criterio para avanzar', help: 'La secuencia de estados y, para cada paso, qué tiene que estar completo para proponer el avance. Declara también CADA valor real del campo de estado: cualquier valor no listado se trata como anómalo y se avisa, en vez de ignorarse en silencio.' },
  automations: { label: 'Automatizaciones que ya existen (no duplicar)', help: 'Qué dispara el sistema solo al cambiar un campo (facturas, documentos, mensajes, integraciones). Si no lo dices, el empleado puede proponer crear a mano algo que el sistema ya genera, duplicando trabajo o datos.' },
  dataQuirks: { label: 'Peculiaridades de los datos', help: 'Campos que no sirven para lo que parecen (ruido de una migración, un campo con nombre engañoso), o nombres de campo que hay que usar literalmente. Esto evita que el empleado "invente" un nombre de campo razonable que en realidad no existe en tu sistema.' },
  autonomy: { label: 'Qué puede hacer solo y qué requiere aprobación', help: 'En lenguaje de negocio, no solo con el selector de autonomía: así el empleado entiende el PORQUÉ (p. ej. "cambiar el estado dispara facturación") y no solo la regla.' },
  reporting: { label: 'Cómo debe avisar', help: 'El formato exacto de cada aviso y cómo agrupar por urgencia. Sin esto, los informes son prosa libre difícil de escanear.' },
  priorities: { label: 'Orden de prioridad cuando hay varias cosas', help: 'Qué mirar primero si hay más de un asunto a la vez.' },
  queryHints: { label: 'Cómo consultar los datos (técnico)', help: 'Patrones de consulta correctos para TU conector concreto (qué parámetro usar, qué evitar). Se completa en la puesta a punto si lo dejas en blanco.' },
  notes: { label: 'Notas adicionales', help: 'Cualquier otra cosa en texto libre que no encaje arriba.' },
};

export function renderBlueprint(bp = {}) {
  const v = bp.variants?.length ? list(bp.variants, (x) => `**${x.name}**: ${x.rule}`) : '';
  const st = bp.stages?.length
    ? `${bp.stateField ? `Campo de estado: ${bp.stateField}.\n` : ''}${bp.allStateValues ? `Valores reales (cualquier otro es anómalo, avisa): ${bp.allStateValues}\n` : ''}\nSecuencia y qué exigir para avanzar:\n${list(bp.stages, (s) => `**${s.from} → ${s.to}**: ${s.requirement}`)}${bp.completionRule ? `\n\nRegla de completitud: ${bp.completionRule}` : ''}`
    : '';
  const sections = [
    block('CONTEXTO', bp.context),
    block('VARIANTES A DISTINGUIR (identifícalas primero)', v),
    block('SECUENCIA DE FASES Y CRITERIO PARA AVANZAR', st),
    block('AUTOMATIZACIONES QUE YA EXISTEN (no las dupliques)', bp.automations),
    block('PECULIARIDADES DE LOS DATOS', bp.dataQuirks),
    block('QUÉ PUEDES HACER SOLO Y QUÉ REQUIERE APROBACIÓN', bp.autonomyNotes),
    block('CÓMO AVISAR', bp.reportFormat),
    block('PRIORIDAD', bp.priorities?.length ? list(bp.priorities.map((p, i) => `${i + 1}) ${p}`)) : ''),
    block('CÓMO CONSULTAR LOS DATOS', bp.queryHints),
    block('NOTAS ADICIONALES', bp.notes),
  ].filter(Boolean);
  return sections.join('\n\n');
}

/** Puntuación de completitud del blueprint: ayuda a saber si el empleado está listo para trabajar solo. */
export function blueprintCompleteness(bp = {}) {
  const checks = [
    ['context', !!bp.context?.trim(), 'Sin contexto del negocio: el empleado no sabrá qué es relevante'],
    ['stages', !!bp.stages?.length, 'Sin fases definidas: no podrá evaluar si algo está listo para avanzar'],
    ['stateValues', !!bp.allStateValues?.trim(), 'Sin los valores reales del campo de estado: tratará cualquier valor inesperado como silencioso en vez de avisar'],
    ['automations', !!bp.automations?.trim(), 'Sin automatizaciones declaradas: riesgo de que proponga duplicar algo que el sistema ya hace solo'],
    ['autonomy', !!bp.autonomyNotes?.trim(), 'Sin explicar el motivo de las aprobaciones: pedirá aprobación sin poder justificarla bien'],
    ['reporting', !!bp.reportFormat?.trim(), 'Sin formato de aviso: los informes pueden quedar en prosa difícil de escanear'],
  ];
  const score = Math.round((checks.filter((c) => c[1]).length / checks.length) * 100);
  return { score, missing: checks.filter((c) => !c[1]).map((c) => c[2]) };
}
