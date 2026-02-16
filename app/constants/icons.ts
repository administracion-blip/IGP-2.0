/**
 * Iconos de acciones de la app. Usar siempre estos para mantener consistencia.
 * Orden: add, delete, edit, selectMultiple, clear.
 * Solo añadir nuevos cuando la acción no esté definida o el usuario lo indique.
 */
export const ICONS = {
  add: 'add-circle-outline',
  delete: 'delete-outline',
  edit: 'edit',
  selectMultiple: 'checklist',
  clear: 'cleaning-services',
} as const;

/** Tamaño de los iconos de acción (un poco fino para que quede más bonito) */
export const ICON_SIZE = 18;

export type ActionIcon = keyof typeof ICONS;
