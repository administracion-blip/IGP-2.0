/**
 * [SEC S-11] Opciones Helmet compartidas: CSP en report-only para la API JSON.
 * No enforcing; no aplica al documento Expo web.
 */
export const helmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    reportOnly: true,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
};
