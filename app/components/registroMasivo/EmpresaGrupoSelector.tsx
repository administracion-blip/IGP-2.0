import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Borrador, EmpresaCatalogo } from '../../types/registroMasivo';
import type { UseEmpresasGrupoReturn } from '../../hooks/useEmpresasGrupo';

/**
 * Bloque "Empresa (GRUPO PARIPE)" del formulario de registro masivo:
 * input de búsqueda + dropdown de sociedades del grupo + indicador de
 * sociedad asignada / aviso si falta.
 *
 * Lectura desde `borrador` (sociedad_grupo_*); escritura vía callbacks:
 * - `onSeleccionar(e)`: el padre llama al hook para asignar y reconciliar.
 * - `onLimpiarAsignada()`: cuando el usuario empieza a teclear con una
 *   sociedad ya asignada, el padre la borra para que se vea claro que
 *   debe elegir otra.
 */
export function EmpresaGrupoSelector({
  empGrupo,
  borrador,
  onSeleccionar,
  onLimpiarAsignada,
}: {
  empGrupo: UseEmpresasGrupoReturn;
  borrador: Borrador;
  onSeleccionar: (e: EmpresaCatalogo) => void;
  onLimpiarAsignada: () => void;
}) {
  return (
    <View style={styles.sociedadBlock}>
      <Text style={styles.sociedadTitle}>Empresa (GRUPO PARIPE) *</Text>
      <Text style={styles.sociedadHint}>
        Sociedad del grupo que recibe el gasto (se guarda como emisor)
      </Text>
      {empGrupo.hayCatalogo && !empGrupo.hayGrupoParipe ? (
        <Text style={styles.sociedadMaestroWarn}>
          No hay empresas con sede «GRUPO PARIPE» en el maestro. Revisa el campo Sede en Empresas.
        </Text>
      ) : null}
      <View style={styles.sociedadSelector}>
        <TextInput
          style={styles.sociedadInput}
          placeholder="Buscar empresa por nombre o CIF…"
          placeholderTextColor="#94a3b8"
          value={empGrupo.search || borrador.sociedad_grupo_nombre || ''}
          onChangeText={(t) => {
            empGrupo.setSearch(t);
            empGrupo.setShowDropdown(true);
            if (borrador.sociedad_grupo_id) onLimpiarAsignada();
          }}
          onFocus={() => empGrupo.setShowDropdown(true)}
        />
        {empGrupo.showDropdown && empGrupo.empresasGrupoFiltradas.length > 0 && (
          <ScrollView
            style={styles.sociedadDropdown}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {empGrupo.empresasGrupoFiltradas.slice(0, 25).map((e) => {
              const id = e.id_empresa != null ? String(e.id_empresa) : '';
              return (
                <TouchableOpacity
                  key={id || e.Cif || e.Nombre}
                  style={styles.sociedadDropdownItem}
                  onPress={() => onSeleccionar(e)}
                >
                  <Text style={styles.sociedadDropdownName} numberOfLines={2}>
                    {e.Nombre || '—'}
                  </Text>
                  <Text style={styles.sociedadDropdownCif}>{e.Cif || ''}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>
      {borrador.sociedad_grupo_id ? (
        <Text style={styles.sociedadOk}>
          {borrador.sociedad_grupo_cif ? `${borrador.sociedad_grupo_cif} · ` : ''}
          {borrador.sociedad_grupo_nombre}
        </Text>
      ) : (
        <Text style={styles.sociedadWarn}>Obligatorio antes de confirmar</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sociedadBlock: {
    marginBottom: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    zIndex: 40,
  },
  sociedadTitle: { fontSize: 12, fontWeight: '700', color: '#334155', marginBottom: 4 },
  sociedadHint: { fontSize: 10, color: '#64748b', marginBottom: 6, lineHeight: 14 },
  sociedadMaestroWarn: {
    fontSize: 10,
    color: '#b45309',
    marginBottom: 8,
    lineHeight: 14,
    backgroundColor: '#fffbeb',
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  sociedadSelector: { position: 'relative', zIndex: 50 },
  sociedadInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  sociedadDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    maxHeight: 200,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    marginTop: 4,
    zIndex: 100,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  sociedadDropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  sociedadDropdownName: { fontSize: 12, fontWeight: '600', color: '#334155' },
  sociedadDropdownCif: { fontSize: 10, color: '#64748b', marginTop: 2 },
  sociedadOk: { fontSize: 10, color: '#059669', marginTop: 6, fontWeight: '500' },
  sociedadWarn: { fontSize: 10, color: '#b45309', marginTop: 6 },
});
