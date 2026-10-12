import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * One PrimeNG preset for the dashboard and the extension panel, so the two
 * read as one product. Teal primary (clinical, calm); Aura's own light/dark
 * surfaces, switched by the OS setting.
 */
export const AppPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{teal.50}',
      100: '{teal.100}',
      200: '{teal.200}',
      300: '{teal.300}',
      400: '{teal.400}',
      500: '{teal.500}',
      600: '{teal.600}',
      700: '{teal.700}',
      800: '{teal.800}',
      900: '{teal.900}',
      950: '{teal.950}',
    },
  },
});

export const primeNgThemeConfig = {
  theme: {
    preset: AppPreset,
    options: {
      darkModeSelector: 'system',
      cssLayer: { name: 'primeng', order: 'primeng, tailwind-base, tailwind-utilities' },
    },
  },
};
