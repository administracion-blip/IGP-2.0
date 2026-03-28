/**
 * Carga la fuente material antes que el árbol de expo-router para evitar
 * primer frame con iconos vacíos (@expo/vector-icons devuelve <Text /> hasta cargar).
 */
import { MaterialIcons } from '@expo/vector-icons';

const MI = MaterialIcons as unknown as { loadFont: () => Promise<void> };
void MI.loadFont();
