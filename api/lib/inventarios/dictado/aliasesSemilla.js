/**
 * Alias semilla del dictado por voz: formas habituales (y errores típicos del transcriptor) de
 * marcas frecuentes en hostelería.
 *
 * Apuntan a un FRAGMENTO de nombre de producto (normalizado), no a un productId, porque los ids
 * cambian por almacén. El matcher sustituye el `texto` dicho (al principio de la lectura) por el
 * `nombre` y busca productos activos que contengan ese fragmento: con uno solo → ese producto;
 * con varios → ambiguo (salvo que uno sea la versión base y el resto variantes, ver matcher.js).
 *
 * Los alias del usuario/globales siempre tienen prioridad sobre la semilla.
 * Solo marcas: nada de palabras genéricas de categoría («tónica», «estrella»), que casarían con
 * productos de varias marcas.
 */

/** @type {ReadonlyArray<Readonly<{ texto: string, nombre: string }>>} */
export const ALIAS_SEMILLA = Object.freeze(
  [
    // Refrescos
    ['coca', 'coca cola'],
    ['cocacola', 'coca cola'],
    ['coca cola', 'coca cola'],
    ['coca zero', 'coca cola zero'],
    ['cocacola zero', 'coca cola zero'],
    ['redbull', 'red bull'],
    ['red bul', 'red bull'],
    ['aquarius', 'aquarius'],
    ['acuarius', 'aquarius'],
    ['nestea', 'nestea'],
    ['nesti', 'nestea'],
    ['schweppes', 'schweppes'],
    ['schwepps', 'schweppes'],
    ['esvepes', 'schweppes'],
    ['fanta naranja', 'fanta naranja'],
    ['fanta limon', 'fanta limon'],
    // Whisky
    ['johnnie', 'johnnie walker'],
    ['johnny', 'johnnie walker'],
    ['jonny', 'johnnie walker'],
    ['johnny walker', 'johnnie walker'],
    ['johnnie walker', 'johnnie walker'],
    ['ballantines', 'ballantine'],
    ['valentines', 'ballantine'],
    ['jota be', 'j b'],
    // Licores
    ['jagger', 'jagermeister'],
    ['jager', 'jagermeister'],
    ['jaguer', 'jagermeister'],
    ['jagermeister', 'jagermeister'],
    ['ruavieja', 'ruavieja'],
    ['rua vieja', 'ruavieja'],
    ['montoro', 'montoro'],
    ['martini blanco', 'martini bianco'],
    // Ginebra
    ['puerto indias', 'puerto de indias'],
    ['seagrams', 'seagram'],
    ['seagram', 'seagram'],
    ['beefeater', 'beefeater'],
    ['bifiter', 'beefeater'],
    ['bifeater', 'beefeater'],
    ['tanqueray', 'tanqueray'],
    ['tanquerai', 'tanqueray'],
    ['tanqueri', 'tanqueray'],
    ['hendricks', 'hendrick'],
    ['hendrix', 'hendrick'],
    ['gordons', 'gordon'],
    // Ron y vodka
    ['brugal', 'brugal'],
    ['brujal', 'brugal'],
    ['barcelo', 'barcelo'],
    ['barselo', 'barcelo'],
    ['habana', 'havana club'],
    ['havana', 'havana club'],
    ['absolut', 'absolut'],
    ['absolute', 'absolut'],
    ['apsolut', 'absolut'],
    // Cerveza
    ['mahou', 'mahou'],
    ['maou', 'mahou'],
    ['estrella galicia', 'estrella galicia'],
    ['cruzcampo', 'cruzcampo'],
    ['cruz campo', 'cruzcampo'],
    ['alhambra', 'alhambra'],
    ['alambra', 'alhambra'],
  ].map(([texto, nombre]) => Object.freeze({ texto, nombre })),
);
