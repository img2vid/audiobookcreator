// ============================================================
// Openmukti Audiobook Creator — branching hardware specifications database
// Owned by Task 1-d. Drives the Brand → Generation → Model
// cascading selects (Settings) + the autotune scoring engine.
//
// Data notes:
// - CPU core/thread counts are real, per-vendor specs (SMT-aware).
// - Apple chips: `cores` = performance-core count (P+E configs),
//   threads = cores (Apple Silicon has no SMT).
// - GPU `teraflops` = FP32 shader TFLOPS; `tensorCores` NVIDIA-only.
// - Apple GPUs are integrated with unified memory — `vramGB` is the
//   nominal base-config shared memory pool.
// ============================================================

import type { CpuBrand, GpuBrand } from '@/lib/types';

// ------------------------------------------------------------
// CPU database
// ------------------------------------------------------------

export const CPU_BRANDS: CpuBrand[] = [
  // ---------- Intel ----------
  {
    id: 'intel',
    name: 'Intel',
    generations: [
      {
        id: 'intel-legacy',
        name: 'Legacy (Core 2 / 1st Gen)',
        years: '2006–2010',
        models: [
          { id: 'core-2-duo-e6600', name: 'Core 2 Duo E6600', cores: 2, threads: 2, baseGhz: 2.4, tdpW: 65, year: 2006 },
          { id: 'core-2-quad-q6600', name: 'Core 2 Quad Q6600', cores: 4, threads: 4, baseGhz: 2.4, tdpW: 95, year: 2007 },
          { id: 'core-2-duo-e8400', name: 'Core 2 Duo E8400', cores: 2, threads: 2, baseGhz: 3.0, tdpW: 65, year: 2008 },
          { id: 'core-2-quad-q9550', name: 'Core 2 Quad Q9550', cores: 4, threads: 4, baseGhz: 2.83, tdpW: 95, year: 2008 },
          { id: 'i7-920', name: 'Core i7-920', cores: 4, threads: 8, baseGhz: 2.66, boostGhz: 2.93, tdpW: 130, year: 2008 },
          { id: 'i5-750', name: 'Core i5-750', cores: 4, threads: 4, baseGhz: 2.66, boostGhz: 3.2, tdpW: 95, year: 2009 },
          { id: 'i7-860', name: 'Core i7-860', cores: 4, threads: 8, baseGhz: 2.8, boostGhz: 3.46, tdpW: 95, year: 2009 },
          { id: 'i3-540', name: 'Core i3-540', cores: 2, threads: 4, baseGhz: 3.06, tdpW: 73, year: 2010 },
          { id: 'i7-980x', name: 'Core i7-980X Extreme', cores: 6, threads: 12, baseGhz: 3.33, boostGhz: 3.6, tdpW: 130, year: 2010 },
        ],
      },
      {
        id: 'intel-2nd-gen',
        name: '2nd Gen (Sandy Bridge)',
        years: '2011–2012',
        models: [
          { id: 'i3-2100', name: 'Core i3-2100', cores: 2, threads: 4, baseGhz: 3.1, tdpW: 65, year: 2011 },
          { id: 'i3-2120', name: 'Core i3-2120', cores: 2, threads: 4, baseGhz: 3.3, tdpW: 65, year: 2011 },
          { id: 'i5-2400', name: 'Core i5-2400', cores: 4, threads: 4, baseGhz: 3.1, boostGhz: 3.4, tdpW: 95, year: 2011 },
          { id: 'i5-2500k', name: 'Core i5-2500K', cores: 4, threads: 4, baseGhz: 3.3, boostGhz: 3.7, tdpW: 95, year: 2011 },
          { id: 'i7-2600k', name: 'Core i7-2600K', cores: 4, threads: 8, baseGhz: 3.4, boostGhz: 3.8, tdpW: 95, year: 2011 },
          { id: 'i7-2700k', name: 'Core i7-2700K', cores: 4, threads: 8, baseGhz: 3.5, boostGhz: 3.9, tdpW: 95, year: 2012 },
        ],
      },
      {
        id: 'intel-3rd-gen',
        name: '3rd Gen (Ivy Bridge)',
        years: '2012–2013',
        models: [
          { id: 'i3-3220', name: 'Core i3-3220', cores: 2, threads: 4, baseGhz: 3.3, tdpW: 55, year: 2012 },
          { id: 'i5-3330', name: 'Core i5-3330', cores: 4, threads: 4, baseGhz: 3.0, boostGhz: 3.2, tdpW: 77, year: 2012 },
          { id: 'i5-3450', name: 'Core i5-3450', cores: 4, threads: 4, baseGhz: 3.1, boostGhz: 3.5, tdpW: 77, year: 2012 },
          { id: 'i5-3570k', name: 'Core i5-3570K', cores: 4, threads: 4, baseGhz: 3.4, boostGhz: 3.8, tdpW: 77, year: 2012 },
          { id: 'i7-3770', name: 'Core i7-3770', cores: 4, threads: 8, baseGhz: 3.4, boostGhz: 3.9, tdpW: 77, year: 2012 },
          { id: 'i7-3770k', name: 'Core i7-3770K', cores: 4, threads: 8, baseGhz: 3.5, boostGhz: 3.9, tdpW: 77, year: 2012 },
        ],
      },
      {
        id: 'intel-4th-gen',
        name: '4th Gen (Haswell)',
        years: '2013–2014',
        models: [
          { id: 'i3-4130', name: 'Core i3-4130', cores: 2, threads: 4, baseGhz: 3.4, tdpW: 54, year: 2013 },
          { id: 'i5-4460', name: 'Core i5-4460', cores: 4, threads: 4, baseGhz: 3.2, boostGhz: 3.4, tdpW: 84, year: 2014 },
          { id: 'i5-4590', name: 'Core i5-4590', cores: 4, threads: 4, baseGhz: 3.3, boostGhz: 3.7, tdpW: 84, year: 2014 },
          { id: 'i5-4690k', name: 'Core i5-4690K', cores: 4, threads: 4, baseGhz: 3.5, boostGhz: 3.9, tdpW: 88, year: 2014 },
          { id: 'i7-4770k', name: 'Core i7-4770K', cores: 4, threads: 8, baseGhz: 3.5, boostGhz: 3.9, tdpW: 84, year: 2013 },
          { id: 'i7-4790k', name: 'Core i7-4790K', cores: 4, threads: 8, baseGhz: 4.0, boostGhz: 4.4, tdpW: 88, year: 2014 },
          { id: 'i7-5960x', name: 'Core i7-5960X Extreme', cores: 8, threads: 16, baseGhz: 3.0, boostGhz: 3.5, tdpW: 140, year: 2014 },
        ],
      },
      {
        id: 'intel-5th-gen',
        name: '5th Gen (Broadwell)',
        years: '2015',
        models: [
          { id: 'i5-5675c', name: 'Core i5-5675C', cores: 4, threads: 4, baseGhz: 3.1, boostGhz: 3.6, tdpW: 65, year: 2015 },
          { id: 'i7-5775c', name: 'Core i7-5775C', cores: 4, threads: 8, baseGhz: 3.3, boostGhz: 3.7, tdpW: 65, year: 2015 },
        ],
      },
      {
        id: 'intel-6th-gen',
        name: '6th Gen (Skylake)',
        years: '2015–2016',
        models: [
          { id: 'i3-6100', name: 'Core i3-6100', cores: 2, threads: 4, baseGhz: 3.7, tdpW: 51, year: 2015 },
          { id: 'i5-6400', name: 'Core i5-6400', cores: 4, threads: 4, baseGhz: 2.7, boostGhz: 3.3, tdpW: 65, year: 2015 },
          { id: 'i5-6600k', name: 'Core i5-6600K', cores: 4, threads: 4, baseGhz: 3.5, boostGhz: 3.9, tdpW: 91, year: 2015 },
          { id: 'i7-6700', name: 'Core i7-6700', cores: 4, threads: 8, baseGhz: 3.4, boostGhz: 4.0, tdpW: 65, year: 2015 },
          { id: 'i7-6700k', name: 'Core i7-6700K', cores: 4, threads: 8, baseGhz: 4.0, boostGhz: 4.2, tdpW: 91, year: 2015 },
        ],
      },
      {
        id: 'intel-7th-gen',
        name: '7th Gen (Kaby Lake)',
        years: '2017',
        models: [
          { id: 'i3-7100', name: 'Core i3-7100', cores: 2, threads: 4, baseGhz: 3.9, tdpW: 51, year: 2017 },
          { id: 'i5-7400', name: 'Core i5-7400', cores: 4, threads: 4, baseGhz: 3.0, boostGhz: 3.5, tdpW: 65, year: 2017 },
          { id: 'i5-7600k', name: 'Core i5-7600K', cores: 4, threads: 4, baseGhz: 3.8, boostGhz: 4.2, tdpW: 91, year: 2017 },
          { id: 'i7-7700', name: 'Core i7-7700', cores: 4, threads: 8, baseGhz: 3.6, boostGhz: 4.2, tdpW: 65, year: 2017 },
          { id: 'i7-7700k', name: 'Core i7-7700K', cores: 4, threads: 8, baseGhz: 4.2, boostGhz: 4.5, tdpW: 91, year: 2017 },
        ],
      },
      {
        id: 'intel-8th-gen',
        name: '8th Gen (Coffee Lake)',
        years: '2017–2018',
        models: [
          { id: 'i3-8100', name: 'Core i3-8100', cores: 4, threads: 4, baseGhz: 3.6, tdpW: 65, year: 2017 },
          { id: 'i5-8400', name: 'Core i5-8400', cores: 6, threads: 6, baseGhz: 2.8, boostGhz: 4.0, tdpW: 65, year: 2017 },
          { id: 'i5-8600k', name: 'Core i5-8600K', cores: 6, threads: 6, baseGhz: 3.6, boostGhz: 4.3, tdpW: 95, year: 2017 },
          { id: 'i7-8700', name: 'Core i7-8700', cores: 6, threads: 12, baseGhz: 3.2, boostGhz: 4.6, tdpW: 65, year: 2017 },
          { id: 'i7-8700k', name: 'Core i7-8700K', cores: 6, threads: 12, baseGhz: 3.7, boostGhz: 4.7, tdpW: 95, year: 2017 },
        ],
      },
      {
        id: 'intel-9th-gen',
        name: '9th Gen (Coffee Lake Refresh)',
        years: '2018–2019',
        models: [
          { id: 'i5-9400f', name: 'Core i5-9400F', cores: 6, threads: 6, baseGhz: 2.9, boostGhz: 4.1, tdpW: 65, year: 2019 },
          { id: 'i5-9600k', name: 'Core i5-9600K', cores: 6, threads: 6, baseGhz: 3.7, boostGhz: 4.6, tdpW: 95, year: 2018 },
          { id: 'i7-9700', name: 'Core i7-9700', cores: 8, threads: 8, baseGhz: 3.0, boostGhz: 4.7, tdpW: 65, year: 2019 },
          { id: 'i7-9700k', name: 'Core i7-9700K', cores: 8, threads: 8, baseGhz: 3.6, boostGhz: 4.9, tdpW: 95, year: 2018 },
          { id: 'i9-9900k', name: 'Core i9-9900K', cores: 8, threads: 16, baseGhz: 3.6, boostGhz: 5.0, tdpW: 95, year: 2018 },
          { id: 'i9-9900ks', name: 'Core i9-9900KS', cores: 8, threads: 16, baseGhz: 4.0, boostGhz: 5.0, tdpW: 127, year: 2019 },
        ],
      },
      {
        id: 'intel-10th-gen',
        name: '10th Gen (Comet Lake)',
        years: '2020',
        models: [
          { id: 'i3-10100', name: 'Core i3-10100', cores: 4, threads: 8, baseGhz: 3.6, boostGhz: 4.2, tdpW: 65, year: 2020 },
          { id: 'i5-10400', name: 'Core i5-10400', cores: 6, threads: 12, baseGhz: 2.9, boostGhz: 4.3, tdpW: 65, year: 2020 },
          { id: 'i5-10600k', name: 'Core i5-10600K', cores: 6, threads: 12, baseGhz: 4.1, boostGhz: 4.8, tdpW: 125, year: 2020 },
          { id: 'i7-10700k', name: 'Core i7-10700K', cores: 8, threads: 16, baseGhz: 3.8, boostGhz: 5.1, tdpW: 125, year: 2020 },
          { id: 'i9-10850k', name: 'Core i9-10850K', cores: 10, threads: 20, baseGhz: 3.6, boostGhz: 5.2, tdpW: 125, year: 2020 },
          { id: 'i9-10900k', name: 'Core i9-10900K', cores: 10, threads: 20, baseGhz: 3.7, boostGhz: 5.3, tdpW: 125, year: 2020 },
        ],
      },
      {
        id: 'intel-11th-gen',
        name: '11th Gen (Rocket Lake)',
        years: '2021',
        models: [
          { id: 'i5-11400', name: 'Core i5-11400', cores: 6, threads: 12, baseGhz: 2.6, boostGhz: 4.4, tdpW: 65, year: 2021 },
          { id: 'i5-11600k', name: 'Core i5-11600K', cores: 6, threads: 12, baseGhz: 3.9, boostGhz: 4.9, tdpW: 125, year: 2021 },
          { id: 'i7-11700k', name: 'Core i7-11700K', cores: 8, threads: 16, baseGhz: 3.6, boostGhz: 5.0, tdpW: 125, year: 2021 },
          { id: 'i9-11900k', name: 'Core i9-11900K', cores: 8, threads: 16, baseGhz: 3.5, boostGhz: 5.3, tdpW: 125, year: 2021 },
        ],
      },
      {
        id: 'intel-12th-gen',
        name: '12th Gen (Alder Lake)',
        years: '2021–2022',
        models: [
          { id: 'i3-12100', name: 'Core i3-12100', cores: 4, threads: 8, baseGhz: 3.3, boostGhz: 4.3, tdpW: 60, year: 2022 },
          { id: 'i5-12400', name: 'Core i5-12400', cores: 6, threads: 12, baseGhz: 2.5, boostGhz: 4.4, tdpW: 65, year: 2022 },
          { id: 'i5-12600k', name: 'Core i5-12600K', cores: 10, threads: 16, baseGhz: 3.7, boostGhz: 4.9, tdpW: 125, year: 2021 },
          { id: 'i7-12700k', name: 'Core i7-12700K', cores: 12, threads: 20, baseGhz: 2.7, boostGhz: 5.0, tdpW: 125, year: 2021 },
          { id: 'i9-12900k', name: 'Core i9-12900K', cores: 16, threads: 24, baseGhz: 3.2, boostGhz: 5.2, tdpW: 125, year: 2021 },
        ],
      },
      {
        id: 'intel-13th-gen',
        name: '13th Gen (Raptor Lake)',
        years: '2022–2023',
        models: [
          { id: 'i3-13100', name: 'Core i3-13100', cores: 4, threads: 8, baseGhz: 3.4, boostGhz: 4.5, tdpW: 60, year: 2023 },
          { id: 'i5-13400', name: 'Core i5-13400', cores: 10, threads: 16, baseGhz: 2.5, boostGhz: 4.6, tdpW: 65, year: 2023 },
          { id: 'i5-13600k', name: 'Core i5-13600K', cores: 14, threads: 20, baseGhz: 3.5, boostGhz: 5.1, tdpW: 125, year: 2022 },
          { id: 'i7-13700k', name: 'Core i7-13700K', cores: 16, threads: 24, baseGhz: 3.4, boostGhz: 5.4, tdpW: 125, year: 2022 },
          { id: 'i9-13900k', name: 'Core i9-13900K', cores: 24, threads: 32, baseGhz: 3.0, boostGhz: 5.8, tdpW: 125, year: 2022 },
          { id: 'i9-13900ks', name: 'Core i9-13900KS', cores: 24, threads: 32, baseGhz: 3.2, boostGhz: 6.0, tdpW: 150, year: 2023 },
        ],
      },
      {
        id: 'intel-14th-gen',
        name: '14th Gen (Raptor Lake Refresh)',
        years: '2023–2024',
        models: [
          { id: 'i3-14100', name: 'Core i3-14100', cores: 4, threads: 8, baseGhz: 3.5, boostGhz: 4.6, tdpW: 60, year: 2024 },
          { id: 'i5-14400', name: 'Core i5-14400', cores: 10, threads: 16, baseGhz: 2.5, boostGhz: 4.7, tdpW: 65, year: 2024 },
          { id: 'i5-14600k', name: 'Core i5-14600K', cores: 14, threads: 20, baseGhz: 3.5, boostGhz: 5.3, tdpW: 125, year: 2023 },
          { id: 'i7-14700k', name: 'Core i7-14700K', cores: 20, threads: 28, baseGhz: 3.4, boostGhz: 5.4, tdpW: 125, year: 2023 },
          { id: 'i9-14900k', name: 'Core i9-14900K', cores: 24, threads: 32, baseGhz: 3.2, boostGhz: 6.0, tdpW: 125, year: 2023 },
          { id: 'i9-14900ks', name: 'Core i9-14900KS', cores: 24, threads: 32, baseGhz: 3.2, boostGhz: 6.2, tdpW: 150, year: 2024 },
        ],
      },
      {
        id: 'intel-ultra-1',
        name: 'Core Ultra Series 1 (Meteor Lake)',
        years: '2023–2024',
        models: [
          { id: 'ultra-5-125h', name: 'Core Ultra 5 125H', cores: 14, threads: 18, baseGhz: 3.6, boostGhz: 4.5, tdpW: 28, year: 2023 },
          { id: 'ultra-7-155h', name: 'Core Ultra 7 155H', cores: 16, threads: 22, baseGhz: 3.8, boostGhz: 4.8, tdpW: 28, year: 2023 },
          { id: 'ultra-9-185h', name: 'Core Ultra 9 185H', cores: 16, threads: 22, baseGhz: 2.5, boostGhz: 5.1, tdpW: 45, year: 2024 },
        ],
      },
      {
        id: 'intel-ultra-2',
        name: 'Core Ultra Series 2 (Arrow Lake)',
        years: '2024–2025',
        models: [
          { id: 'ultra-5-245k', name: 'Core Ultra 5 245K', cores: 14, threads: 14, baseGhz: 4.2, boostGhz: 5.2, tdpW: 125, year: 2024 },
          { id: 'ultra-7-265k', name: 'Core Ultra 7 265K', cores: 20, threads: 20, baseGhz: 3.9, boostGhz: 5.5, tdpW: 125, year: 2024 },
          { id: 'ultra-9-285k', name: 'Core Ultra 9 285K', cores: 24, threads: 24, baseGhz: 3.7, boostGhz: 5.7, tdpW: 125, year: 2024 },
        ],
      },
      {
        id: 'intel-xeon',
        name: 'Xeon (Workstation / Server)',
        years: '2014–2024',
        models: [
          { id: 'e5-2620-v3', name: 'Xeon E5-2620 v3', cores: 6, threads: 12, baseGhz: 2.4, boostGhz: 3.2, tdpW: 85, year: 2014 },
          { id: 'e5-2650-v4', name: 'Xeon E5-2650 v4', cores: 12, threads: 24, baseGhz: 2.2, boostGhz: 2.9, tdpW: 105, year: 2016 },
          { id: 'e5-2680-v4', name: 'Xeon E5-2680 v4', cores: 14, threads: 28, baseGhz: 2.4, boostGhz: 3.3, tdpW: 120, year: 2016 },
          { id: 'e5-2699-v4', name: 'Xeon E5-2699 v4', cores: 22, threads: 44, baseGhz: 2.2, boostGhz: 3.6, tdpW: 145, year: 2016 },
          { id: 'bronze-3104', name: 'Xeon Bronze 3104', cores: 6, threads: 6, baseGhz: 1.7, tdpW: 85, year: 2017 },
          { id: 'silver-4110', name: 'Xeon Silver 4110', cores: 8, threads: 16, baseGhz: 2.1, boostGhz: 3.0, tdpW: 85, year: 2017 },
          { id: 'platinum-8160', name: 'Xeon Platinum 8160', cores: 24, threads: 48, baseGhz: 2.1, boostGhz: 3.7, tdpW: 150, year: 2017 },
          { id: 'silver-4214', name: 'Xeon Silver 4214', cores: 12, threads: 24, baseGhz: 2.2, boostGhz: 3.2, tdpW: 85, year: 2019 },
          { id: 'gold-5218', name: 'Xeon Gold 5218', cores: 16, threads: 32, baseGhz: 2.3, boostGhz: 3.9, tdpW: 125, year: 2019 },
          { id: 'gold-6248', name: 'Xeon Gold 6248', cores: 20, threads: 40, baseGhz: 2.5, boostGhz: 3.9, tdpW: 150, year: 2019 },
          { id: 'silver-4410y', name: 'Xeon Silver 4410Y', cores: 12, threads: 24, baseGhz: 2.0, boostGhz: 3.9, tdpW: 150, year: 2023 },
          { id: 'gold-6548y-plus', name: 'Xeon Gold 6548Y+', cores: 32, threads: 64, baseGhz: 2.5, boostGhz: 4.1, tdpW: 350, year: 2023 },
        ],
      },
    ],
  },

  // ---------- AMD ----------
  {
    id: 'amd',
    name: 'AMD',
    generations: [
      {
        id: 'amd-fx',
        name: 'Legacy FX Series',
        years: '2012–2014',
        models: [
          { id: 'fx-4300', name: 'FX-4300', cores: 4, threads: 4, baseGhz: 3.8, boostGhz: 4.0, tdpW: 95, year: 2012 },
          { id: 'fx-6300', name: 'FX-6300', cores: 6, threads: 6, baseGhz: 3.5, boostGhz: 4.1, tdpW: 95, year: 2012 },
          { id: 'fx-8350', name: 'FX-8350', cores: 8, threads: 8, baseGhz: 4.0, boostGhz: 4.2, tdpW: 125, year: 2012 },
          { id: 'fx-9590', name: 'FX-9590', cores: 8, threads: 8, baseGhz: 4.7, boostGhz: 5.0, tdpW: 220, year: 2013 },
        ],
      },
      {
        id: 'amd-ryzen-1000',
        name: 'Ryzen 1000 Series (Summit Ridge)',
        years: '2017–2018',
        models: [
          { id: 'r3-1200', name: 'Ryzen 3 1200', cores: 4, threads: 4, baseGhz: 3.1, boostGhz: 3.4, tdpW: 65, year: 2017 },
          { id: 'r3-1300x', name: 'Ryzen 3 1300X', cores: 4, threads: 4, baseGhz: 3.5, boostGhz: 3.7, tdpW: 65, year: 2017 },
          { id: 'r5-1400', name: 'Ryzen 5 1400', cores: 4, threads: 8, baseGhz: 3.2, boostGhz: 3.4, tdpW: 65, year: 2017 },
          { id: 'r5-1500x', name: 'Ryzen 5 1500X', cores: 4, threads: 8, baseGhz: 3.5, boostGhz: 3.7, tdpW: 65, year: 2017 },
          { id: 'r5-1600', name: 'Ryzen 5 1600', cores: 6, threads: 12, baseGhz: 3.2, boostGhz: 3.6, tdpW: 65, year: 2017 },
          { id: 'r5-1600x', name: 'Ryzen 5 1600X', cores: 6, threads: 12, baseGhz: 3.6, boostGhz: 4.0, tdpW: 95, year: 2017 },
          { id: 'r7-1700', name: 'Ryzen 7 1700', cores: 8, threads: 16, baseGhz: 3.0, boostGhz: 3.7, tdpW: 65, year: 2017 },
          { id: 'r7-1700x', name: 'Ryzen 7 1700X', cores: 8, threads: 16, baseGhz: 3.4, boostGhz: 3.8, tdpW: 95, year: 2017 },
          { id: 'r7-1800x', name: 'Ryzen 7 1800X', cores: 8, threads: 16, baseGhz: 3.6, boostGhz: 4.0, tdpW: 95, year: 2017 },
        ],
      },
      {
        id: 'amd-threadripper-1000',
        name: 'Threadripper 1000 Series',
        years: '2017',
        models: [
          { id: 'tr-1900x', name: 'Threadripper 1900X', cores: 8, threads: 16, baseGhz: 3.8, boostGhz: 4.0, tdpW: 180, year: 2017 },
          { id: 'tr-1920x', name: 'Threadripper 1920X', cores: 12, threads: 24, baseGhz: 3.5, boostGhz: 4.0, tdpW: 180, year: 2017 },
          { id: 'tr-1950x', name: 'Threadripper 1950X', cores: 16, threads: 32, baseGhz: 3.4, boostGhz: 4.0, tdpW: 180, year: 2017 },
        ],
      },
      {
        id: 'amd-ryzen-2000',
        name: 'Ryzen 2000 Series (Pinnacle Ridge)',
        years: '2018–2019',
        models: [
          { id: 'r3-2300x', name: 'Ryzen 3 2300X', cores: 4, threads: 4, baseGhz: 3.5, boostGhz: 4.0, tdpW: 65, year: 2018 },
          { id: 'r5-2600', name: 'Ryzen 5 2600', cores: 6, threads: 12, baseGhz: 3.4, boostGhz: 3.9, tdpW: 65, year: 2018 },
          { id: 'r5-2600x', name: 'Ryzen 5 2600X', cores: 6, threads: 12, baseGhz: 3.6, boostGhz: 4.2, tdpW: 95, year: 2018 },
          { id: 'r7-2700', name: 'Ryzen 7 2700', cores: 8, threads: 16, baseGhz: 3.2, boostGhz: 4.1, tdpW: 65, year: 2018 },
          { id: 'r7-2700x', name: 'Ryzen 7 2700X', cores: 8, threads: 16, baseGhz: 3.7, boostGhz: 4.3, tdpW: 105, year: 2018 },
        ],
      },
      {
        id: 'amd-threadripper-2000',
        name: 'Threadripper 2000 Series',
        years: '2018–2019',
        models: [
          { id: 'tr-2920x', name: 'Threadripper 2920X', cores: 12, threads: 24, baseGhz: 3.5, boostGhz: 4.3, tdpW: 180, year: 2018 },
          { id: 'tr-2950x', name: 'Threadripper 2950X', cores: 16, threads: 32, baseGhz: 3.5, boostGhz: 4.4, tdpW: 180, year: 2018 },
          { id: 'tr-2970wx', name: 'Threadripper 2970WX', cores: 24, threads: 48, baseGhz: 3.0, boostGhz: 4.2, tdpW: 250, year: 2018 },
          { id: 'tr-2990wx', name: 'Threadripper 2990WX', cores: 32, threads: 64, baseGhz: 3.0, boostGhz: 4.2, tdpW: 250, year: 2018 },
        ],
      },
      {
        id: 'amd-ryzen-3000',
        name: 'Ryzen 3000 Series (Matisse)',
        years: '2019–2020',
        models: [
          { id: 'r5-3600', name: 'Ryzen 5 3600', cores: 6, threads: 12, baseGhz: 3.6, boostGhz: 4.2, tdpW: 65, year: 2019 },
          { id: 'r5-3600x', name: 'Ryzen 5 3600X', cores: 6, threads: 12, baseGhz: 3.8, boostGhz: 4.4, tdpW: 95, year: 2019 },
          { id: 'r7-3700x', name: 'Ryzen 7 3700X', cores: 8, threads: 16, baseGhz: 3.6, boostGhz: 4.4, tdpW: 65, year: 2019 },
          { id: 'r7-3800x', name: 'Ryzen 7 3800X', cores: 8, threads: 16, baseGhz: 3.9, boostGhz: 4.5, tdpW: 105, year: 2019 },
          { id: 'r9-3900x', name: 'Ryzen 9 3900X', cores: 12, threads: 24, baseGhz: 3.8, boostGhz: 4.6, tdpW: 105, year: 2019 },
          { id: 'r9-3950x', name: 'Ryzen 9 3950X', cores: 16, threads: 32, baseGhz: 3.5, boostGhz: 4.7, tdpW: 105, year: 2019 },
        ],
      },
      {
        id: 'amd-threadripper-3000',
        name: 'Threadripper 3000 Series',
        years: '2019–2020',
        models: [
          { id: 'tr-3960x', name: 'Threadripper 3960X', cores: 24, threads: 48, baseGhz: 3.8, boostGhz: 4.5, tdpW: 280, year: 2019 },
          { id: 'tr-3970x', name: 'Threadripper 3970X', cores: 32, threads: 64, baseGhz: 3.7, boostGhz: 4.5, tdpW: 280, year: 2019 },
          { id: 'tr-3990x', name: 'Threadripper 3990X', cores: 64, threads: 128, baseGhz: 2.9, boostGhz: 4.3, tdpW: 280, year: 2020 },
        ],
      },
      {
        id: 'amd-ryzen-4000g',
        name: 'Ryzen 4000G Series (Renoir APU)',
        years: '2020–2021',
        models: [
          { id: 'r3-4300g', name: 'Ryzen 3 4300G', cores: 4, threads: 8, baseGhz: 3.8, boostGhz: 4.0, tdpW: 65, year: 2020 },
          { id: 'r5-4600g', name: 'Ryzen 5 4600G', cores: 6, threads: 12, baseGhz: 3.7, boostGhz: 4.2, tdpW: 65, year: 2020 },
          { id: 'r7-4700g', name: 'Ryzen 7 4700G', cores: 8, threads: 16, baseGhz: 3.6, boostGhz: 4.4, tdpW: 65, year: 2020 },
        ],
      },
      {
        id: 'amd-ryzen-5000',
        name: 'Ryzen 5000 Series (Vermeer / Cezanne)',
        years: '2020–2022',
        models: [
          { id: 'r5-5600', name: 'Ryzen 5 5600', cores: 6, threads: 12, baseGhz: 3.5, boostGhz: 4.4, tdpW: 65, year: 2022 },
          { id: 'r5-5600x', name: 'Ryzen 5 5600X', cores: 6, threads: 12, baseGhz: 3.7, boostGhz: 4.6, tdpW: 65, year: 2020 },
          { id: 'r7-5700g', name: 'Ryzen 7 5700G', cores: 8, threads: 16, baseGhz: 3.8, boostGhz: 4.6, tdpW: 65, year: 2021 },
          { id: 'r7-5700x', name: 'Ryzen 7 5700X', cores: 8, threads: 16, baseGhz: 3.4, boostGhz: 4.6, tdpW: 65, year: 2022 },
          { id: 'r7-5800x', name: 'Ryzen 7 5800X', cores: 8, threads: 16, baseGhz: 3.8, boostGhz: 4.7, tdpW: 105, year: 2020 },
          { id: 'r7-5800x3d', name: 'Ryzen 7 5800X3D', cores: 8, threads: 16, baseGhz: 3.4, boostGhz: 4.5, tdpW: 105, year: 2022 },
          { id: 'r9-5900x', name: 'Ryzen 9 5900X', cores: 12, threads: 24, baseGhz: 3.7, boostGhz: 4.8, tdpW: 105, year: 2020 },
          { id: 'r9-5950x', name: 'Ryzen 9 5950X', cores: 16, threads: 32, baseGhz: 3.4, boostGhz: 4.9, tdpW: 105, year: 2020 },
        ],
      },
      {
        id: 'amd-threadripper-5000',
        name: 'Threadripper Pro 5000WX Series',
        years: '2022',
        models: [
          { id: 'trpro-5945wx', name: 'Threadripper Pro 5945WX', cores: 12, threads: 24, baseGhz: 4.0, boostGhz: 4.5, tdpW: 280, year: 2022 },
          { id: 'trpro-5955wx', name: 'Threadripper Pro 5955WX', cores: 16, threads: 32, baseGhz: 4.0, boostGhz: 4.5, tdpW: 280, year: 2022 },
          { id: 'trpro-5975wx', name: 'Threadripper Pro 5975WX', cores: 32, threads: 64, baseGhz: 4.0, boostGhz: 4.5, tdpW: 280, year: 2022 },
        ],
      },
      {
        id: 'amd-ryzen-7000',
        name: 'Ryzen 7000 Series (Raphael)',
        years: '2022–2023',
        models: [
          { id: 'r5-7600', name: 'Ryzen 5 7600', cores: 6, threads: 12, baseGhz: 3.8, boostGhz: 5.1, tdpW: 65, year: 2023 },
          { id: 'r5-7600x', name: 'Ryzen 5 7600X', cores: 6, threads: 12, baseGhz: 4.7, boostGhz: 5.3, tdpW: 105, year: 2022 },
          { id: 'r7-7700x', name: 'Ryzen 7 7700X', cores: 8, threads: 16, baseGhz: 4.5, boostGhz: 5.4, tdpW: 105, year: 2022 },
          { id: 'r7-7800x3d', name: 'Ryzen 7 7800X3D', cores: 8, threads: 16, baseGhz: 4.2, boostGhz: 5.0, tdpW: 120, year: 2023 },
          { id: 'r9-7900x', name: 'Ryzen 9 7900X', cores: 12, threads: 24, baseGhz: 4.7, boostGhz: 5.6, tdpW: 170, year: 2022 },
          { id: 'r9-7950x', name: 'Ryzen 9 7950X', cores: 16, threads: 32, baseGhz: 4.5, boostGhz: 5.7, tdpW: 170, year: 2022 },
          { id: 'r9-7950x3d', name: 'Ryzen 9 7950X3D', cores: 16, threads: 32, baseGhz: 4.2, boostGhz: 5.7, tdpW: 170, year: 2023 },
        ],
      },
      {
        id: 'amd-threadripper-7000',
        name: 'Threadripper 7000 Series (Storm Peak)',
        years: '2023',
        models: [
          { id: 'tr-7960x', name: 'Threadripper 7960X', cores: 24, threads: 48, baseGhz: 4.2, boostGhz: 5.3, tdpW: 350, year: 2023 },
          { id: 'tr-7970x', name: 'Threadripper 7970X', cores: 32, threads: 64, baseGhz: 4.0, boostGhz: 5.3, tdpW: 350, year: 2023 },
          { id: 'tr-7980x', name: 'Threadripper 7980X', cores: 64, threads: 128, baseGhz: 2.5, boostGhz: 5.1, tdpW: 350, year: 2023 },
          { id: 'trpro-7995wx', name: 'Threadripper Pro 7995WX', cores: 96, threads: 192, baseGhz: 2.5, boostGhz: 5.1, tdpW: 350, year: 2023 },
        ],
      },
      {
        id: 'amd-ryzen-8000g',
        name: 'Ryzen 8000G Series (Phoenix APU)',
        years: '2024',
        models: [
          { id: 'r3-8300g', name: 'Ryzen 3 8300G', cores: 4, threads: 8, baseGhz: 4.0, boostGhz: 4.9, tdpW: 65, year: 2024 },
          { id: 'r5-8500g', name: 'Ryzen 5 8500G', cores: 6, threads: 12, baseGhz: 4.1, boostGhz: 5.0, tdpW: 65, year: 2024 },
          { id: 'r7-8700f', name: 'Ryzen 7 8700F', cores: 8, threads: 16, baseGhz: 4.1, boostGhz: 5.0, tdpW: 65, year: 2024 },
          { id: 'r7-8700g', name: 'Ryzen 7 8700G', cores: 8, threads: 16, baseGhz: 4.2, boostGhz: 5.1, tdpW: 65, year: 2024 },
        ],
      },
      {
        id: 'amd-ryzen-9000',
        name: 'Ryzen 9000 Series (Granite Ridge)',
        years: '2024–2025',
        models: [
          { id: 'r5-9600x', name: 'Ryzen 5 9600X', cores: 6, threads: 12, baseGhz: 3.9, boostGhz: 5.4, tdpW: 65, year: 2024 },
          { id: 'r7-9700x', name: 'Ryzen 7 9700X', cores: 8, threads: 16, baseGhz: 3.8, boostGhz: 5.5, tdpW: 65, year: 2024 },
          { id: 'r9-9900x', name: 'Ryzen 9 9900X', cores: 12, threads: 24, baseGhz: 4.4, boostGhz: 5.6, tdpW: 120, year: 2024 },
          { id: 'r9-9950x', name: 'Ryzen 9 9950X', cores: 16, threads: 32, baseGhz: 4.3, boostGhz: 5.7, tdpW: 170, year: 2024 },
        ],
      },
    ],
  },

  // ---------- Apple ----------
  {
    id: 'apple',
    name: 'Apple',
    generations: [
      {
        id: 'apple-m1',
        name: 'Apple M1 Family',
        years: '2020–2022',
        models: [
          // M1: 4P+4E — tuned on 4 performance cores, threads = cores (no SMT)
          { id: 'apple-m1', name: 'Apple M1', cores: 4, threads: 4, baseGhz: 3.2, boostGhz: 3.5, tdpW: 20, year: 2020 },
          { id: 'apple-m1-pro', name: 'Apple M1 Pro', cores: 8, threads: 8, baseGhz: 3.2, boostGhz: 3.7, tdpW: 35, year: 2021 },
          { id: 'apple-m1-max', name: 'Apple M1 Max', cores: 8, threads: 8, baseGhz: 3.2, boostGhz: 3.7, tdpW: 60, year: 2021 },
          { id: 'apple-m1-ultra', name: 'Apple M1 Ultra', cores: 16, threads: 16, baseGhz: 3.2, boostGhz: 3.7, tdpW: 90, year: 2022 },
        ],
      },
      {
        id: 'apple-m2',
        name: 'Apple M2 Family',
        years: '2022–2023',
        models: [
          { id: 'apple-m2', name: 'Apple M2', cores: 4, threads: 4, baseGhz: 3.5, boostGhz: 3.7, tdpW: 20, year: 2022 },
          { id: 'apple-m2-pro', name: 'Apple M2 Pro', cores: 8, threads: 8, baseGhz: 3.5, boostGhz: 3.7, tdpW: 35, year: 2023 },
          { id: 'apple-m2-max', name: 'Apple M2 Max', cores: 8, threads: 8, baseGhz: 3.5, boostGhz: 3.7, tdpW: 60, year: 2023 },
          { id: 'apple-m2-ultra', name: 'Apple M2 Ultra', cores: 16, threads: 16, baseGhz: 3.5, boostGhz: 3.7, tdpW: 100, year: 2023 },
        ],
      },
      {
        id: 'apple-m3',
        name: 'Apple M3 Family',
        years: '2023–2024',
        models: [
          { id: 'apple-m3', name: 'Apple M3', cores: 4, threads: 4, baseGhz: 3.2, boostGhz: 4.0, tdpW: 22, year: 2023 },
          { id: 'apple-m3-pro', name: 'Apple M3 Pro', cores: 6, threads: 6, baseGhz: 3.2, boostGhz: 4.0, tdpW: 35, year: 2023 },
          { id: 'apple-m3-max', name: 'Apple M3 Max', cores: 12, threads: 12, baseGhz: 3.2, boostGhz: 4.1, tdpW: 65, year: 2023 },
        ],
      },
      {
        id: 'apple-m4',
        name: 'Apple M4 Family',
        years: '2024–2025',
        models: [
          { id: 'apple-m4', name: 'Apple M4', cores: 4, threads: 4, baseGhz: 3.2, boostGhz: 4.4, tdpW: 22, year: 2024 },
          { id: 'apple-m4-pro', name: 'Apple M4 Pro', cores: 8, threads: 8, baseGhz: 3.2, boostGhz: 4.5, tdpW: 40, year: 2024 },
          { id: 'apple-m4-max', name: 'Apple M4 Max', cores: 12, threads: 12, baseGhz: 3.2, boostGhz: 4.5, tdpW: 70, year: 2024 },
        ],
      },
    ],
  },

  // ---------- Qualcomm ----------
  {
    id: 'qualcomm',
    name: 'Qualcomm',
    generations: [
      {
        id: 'snapdragon-x',
        name: 'Snapdragon X / Compute Series',
        years: '2022–2025',
        models: [
          { id: 'snapdragon-8cx-gen-3', name: 'Snapdragon 8cx Gen 3', cores: 8, threads: 8, baseGhz: 2.4, boostGhz: 3.0, tdpW: 15, year: 2022 },
          { id: 'snapdragon-x-elite-x1e-84-100', name: 'Snapdragon X Elite X1E-84-100', cores: 12, threads: 24, baseGhz: 3.8, boostGhz: 4.3, tdpW: 45, year: 2024 },
          { id: 'snapdragon-x-elite-x1e-80-100', name: 'Snapdragon X Elite X1E-80-100', cores: 12, threads: 24, baseGhz: 3.4, boostGhz: 4.0, tdpW: 45, year: 2024 },
          { id: 'snapdragon-x-plus-x1p-64-100', name: 'Snapdragon X Plus X1P-64-100', cores: 10, threads: 20, baseGhz: 3.4, boostGhz: 4.0, tdpW: 45, year: 2024 },
          { id: 'snapdragon-x-plus-x1p-42-100', name: 'Snapdragon X Plus X1P-42-100', cores: 8, threads: 16, baseGhz: 3.2, boostGhz: 3.8, tdpW: 45, year: 2024 },
        ],
      },
    ],
  },

  // ---------- Custom ----------
  {
    id: 'custom',
    name: 'Custom / Unlisted CPU',
    generations: [], // UI shows manual clock/cores/threads inputs
  },
];

// ------------------------------------------------------------
// GPU database
// ------------------------------------------------------------

export const GPU_BRANDS: GpuBrand[] = [
  // ---------- NVIDIA ----------
  {
    id: 'nvidia',
    name: 'NVIDIA',
    generations: [
      {
        id: 'gtx-900-series',
        name: 'GeForce GTX 900 Series',
        years: '2014–2015',
        models: [
          { id: 'gtx-950', name: 'GeForce GTX 950', vramGB: 2, teraflops: 1.9, year: 2015 },
          { id: 'gtx-960', name: 'GeForce GTX 960', vramGB: 2, teraflops: 2.4, year: 2015 },
          { id: 'gtx-970', name: 'GeForce GTX 970', vramGB: 4, teraflops: 3.5, year: 2014 },
          { id: 'gtx-980', name: 'GeForce GTX 980', vramGB: 4, teraflops: 4.6, year: 2014 },
          { id: 'gtx-980-ti', name: 'GeForce GTX 980 Ti', vramGB: 6, teraflops: 5.6, year: 2015 },
        ],
      },
      {
        id: 'gtx-10-series',
        name: 'GeForce GTX 10 Series (Pascal)',
        years: '2016–2017',
        models: [
          { id: 'gtx-1050', name: 'GeForce GTX 1050', vramGB: 2, teraflops: 1.8, year: 2016 },
          { id: 'gtx-1050-ti', name: 'GeForce GTX 1050 Ti', vramGB: 4, teraflops: 2.1, year: 2016 },
          { id: 'gtx-1060', name: 'GeForce GTX 1060', vramGB: 6, teraflops: 4.4, year: 2016 },
          { id: 'gtx-1070', name: 'GeForce GTX 1070', vramGB: 8, teraflops: 6.5, year: 2016 },
          { id: 'gtx-1070-ti', name: 'GeForce GTX 1070 Ti', vramGB: 8, teraflops: 7.5, year: 2017 },
          { id: 'gtx-1080', name: 'GeForce GTX 1080', vramGB: 8, teraflops: 8.9, year: 2016 },
          { id: 'gtx-1080-ti', name: 'GeForce GTX 1080 Ti', vramGB: 11, teraflops: 11.3, year: 2017 },
        ],
      },
      {
        id: 'gtx-16-series',
        name: 'GeForce GTX 16 Series (Turing)',
        years: '2019',
        models: [
          { id: 'gtx-1650', name: 'GeForce GTX 1650', vramGB: 4, teraflops: 3.0, year: 2019 },
          { id: 'gtx-1650-super', name: 'GeForce GTX 1650 Super', vramGB: 4, teraflops: 4.4, year: 2019 },
          { id: 'gtx-1660', name: 'GeForce GTX 1660', vramGB: 6, teraflops: 5.0, year: 2019 },
          { id: 'gtx-1660-super', name: 'GeForce GTX 1660 Super', vramGB: 6, teraflops: 5.0, year: 2019 },
          { id: 'gtx-1660-ti', name: 'GeForce GTX 1660 Ti', vramGB: 6, teraflops: 5.4, year: 2019 },
        ],
      },
      {
        id: 'rtx-20-series',
        name: 'GeForce RTX 20 Series (Turing)',
        years: '2018–2019',
        models: [
          { id: 'rtx-2060', name: 'GeForce RTX 2060', vramGB: 6, teraflops: 6.5, tensorCores: 240, year: 2019 },
          { id: 'rtx-2060-super', name: 'GeForce RTX 2060 Super', vramGB: 8, teraflops: 7.2, tensorCores: 240, year: 2019 },
          { id: 'rtx-2070', name: 'GeForce RTX 2070', vramGB: 8, teraflops: 7.5, tensorCores: 288, year: 2018 },
          { id: 'rtx-2070-super', name: 'GeForce RTX 2070 Super', vramGB: 8, teraflops: 9.1, tensorCores: 288, year: 2019 },
          { id: 'rtx-2080', name: 'GeForce RTX 2080', vramGB: 8, teraflops: 10.1, tensorCores: 368, year: 2018 },
          { id: 'rtx-2080-super', name: 'GeForce RTX 2080 Super', vramGB: 8, teraflops: 11.2, tensorCores: 368, year: 2019 },
          { id: 'rtx-2080-ti', name: 'GeForce RTX 2080 Ti', vramGB: 11, teraflops: 13.5, tensorCores: 544, year: 2018 },
        ],
      },
      {
        id: 'rtx-30-series',
        name: 'GeForce RTX 30 Series (Ampere)',
        years: '2020–2022',
        models: [
          { id: 'rtx-3050', name: 'GeForce RTX 3050', vramGB: 8, teraflops: 9.1, tensorCores: 80, year: 2021 },
          { id: 'rtx-3060', name: 'GeForce RTX 3060', vramGB: 12, teraflops: 12.7, tensorCores: 112, year: 2021 },
          { id: 'rtx-3060-ti', name: 'GeForce RTX 3060 Ti', vramGB: 8, teraflops: 16.2, tensorCores: 152, year: 2020 },
          { id: 'rtx-3070', name: 'GeForce RTX 3070', vramGB: 8, teraflops: 20.3, tensorCores: 184, year: 2020 },
          { id: 'rtx-3070-ti', name: 'GeForce RTX 3070 Ti', vramGB: 8, teraflops: 21.8, tensorCores: 184, year: 2021 },
          { id: 'rtx-3080', name: 'GeForce RTX 3080', vramGB: 10, teraflops: 29.8, tensorCores: 272, year: 2020 },
          { id: 'rtx-3080-ti', name: 'GeForce RTX 3080 Ti', vramGB: 12, teraflops: 34.1, tensorCores: 320, year: 2021 },
          { id: 'rtx-3090', name: 'GeForce RTX 3090', vramGB: 24, teraflops: 35.6, tensorCores: 328, year: 2020 },
          { id: 'rtx-3090-ti', name: 'GeForce RTX 3090 Ti', vramGB: 24, teraflops: 40.1, tensorCores: 336, year: 2022 },
        ],
      },
      {
        id: 'rtx-40-series',
        name: 'GeForce RTX 40 Series (Ada Lovelace)',
        years: '2022–2024',
        models: [
          { id: 'rtx-4060', name: 'GeForce RTX 4060', vramGB: 8, teraflops: 15.1, tensorCores: 120, year: 2023 },
          { id: 'rtx-4060-ti', name: 'GeForce RTX 4060 Ti', vramGB: 8, teraflops: 22.1, tensorCores: 136, year: 2023 },
          { id: 'rtx-4070', name: 'GeForce RTX 4070', vramGB: 12, teraflops: 29.1, tensorCores: 184, year: 2023 },
          { id: 'rtx-4070-super', name: 'GeForce RTX 4070 Super', vramGB: 12, teraflops: 35.5, tensorCores: 224, year: 2024 },
          { id: 'rtx-4070-ti-super', name: 'GeForce RTX 4070 Ti Super', vramGB: 16, teraflops: 44.1, tensorCores: 280, year: 2024 },
          { id: 'rtx-4080', name: 'GeForce RTX 4080', vramGB: 16, teraflops: 48.7, tensorCores: 304, year: 2022 },
          { id: 'rtx-4080-super', name: 'GeForce RTX 4080 Super', vramGB: 16, teraflops: 52.2, tensorCores: 320, year: 2024 },
          { id: 'rtx-4090', name: 'GeForce RTX 4090', vramGB: 24, teraflops: 82.6, tensorCores: 512, year: 2022 },
        ],
      },
      {
        id: 'rtx-50-series',
        name: 'GeForce RTX 50 Series (Blackwell)',
        years: '2025',
        models: [
          { id: 'rtx-5060', name: 'GeForce RTX 5060', vramGB: 8, teraflops: 19.7, tensorCores: 120, year: 2025 },
          { id: 'rtx-5060-ti', name: 'GeForce RTX 5060 Ti', vramGB: 16, teraflops: 24.2, tensorCores: 144, year: 2025 },
          { id: 'rtx-5070', name: 'GeForce RTX 5070', vramGB: 12, teraflops: 30.9, tensorCores: 184, year: 2025 },
          { id: 'rtx-5070-ti', name: 'GeForce RTX 5070 Ti', vramGB: 16, teraflops: 45.0, tensorCores: 280, year: 2025 },
          { id: 'rtx-5080', name: 'GeForce RTX 5080', vramGB: 16, teraflops: 56.3, tensorCores: 336, year: 2025 },
          { id: 'rtx-5090', name: 'GeForce RTX 5090', vramGB: 32, teraflops: 104.8, tensorCores: 680, year: 2025 },
        ],
      },
    ],
  },

  // ---------- AMD ----------
  {
    id: 'amd',
    name: 'AMD',
    generations: [
      {
        id: 'rx-400-series',
        name: 'Radeon RX 400 Series (Polaris)',
        years: '2016',
        models: [
          { id: 'rx-460', name: 'Radeon RX 460', vramGB: 4, teraflops: 2.2, year: 2016 },
          { id: 'rx-470', name: 'Radeon RX 470', vramGB: 4, teraflops: 4.9, year: 2016 },
          { id: 'rx-480', name: 'Radeon RX 480', vramGB: 8, teraflops: 6.2, year: 2016 },
        ],
      },
      {
        id: 'rx-500-series',
        name: 'Radeon RX 500 Series (Polaris Refresh)',
        years: '2017–2018',
        models: [
          { id: 'rx-550', name: 'Radeon RX 550', vramGB: 4, teraflops: 1.3, year: 2017 },
          { id: 'rx-560', name: 'Radeon RX 560', vramGB: 4, teraflops: 2.6, year: 2017 },
          { id: 'rx-570', name: 'Radeon RX 570', vramGB: 8, teraflops: 5.8, year: 2017 },
          { id: 'rx-580', name: 'Radeon RX 580', vramGB: 8, teraflops: 6.2, year: 2017 },
          { id: 'rx-590', name: 'Radeon RX 590', vramGB: 8, teraflops: 7.1, year: 2018 },
        ],
      },
      {
        id: 'rx-5000-series',
        name: 'Radeon RX 5000 Series (RDNA)',
        years: '2019–2020',
        models: [
          { id: 'rx-5500-xt', name: 'Radeon RX 5500 XT', vramGB: 4, teraflops: 5.2, year: 2019 },
          { id: 'rx-5600-xt', name: 'Radeon RX 5600 XT', vramGB: 6, teraflops: 7.2, year: 2020 },
          { id: 'rx-5700', name: 'Radeon RX 5700', vramGB: 8, teraflops: 7.9, year: 2019 },
          { id: 'rx-5700-xt', name: 'Radeon RX 5700 XT', vramGB: 8, teraflops: 9.8, year: 2019 },
        ],
      },
      {
        id: 'rx-6000-series',
        name: 'Radeon RX 6000 Series (RDNA 2)',
        years: '2020–2022',
        models: [
          { id: 'rx-6500-xt', name: 'Radeon RX 6500 XT', vramGB: 4, teraflops: 5.8, year: 2022 },
          { id: 'rx-6600', name: 'Radeon RX 6600', vramGB: 8, teraflops: 8.9, year: 2021 },
          { id: 'rx-6600-xt', name: 'Radeon RX 6600 XT', vramGB: 8, teraflops: 10.6, year: 2021 },
          { id: 'rx-6700-xt', name: 'Radeon RX 6700 XT', vramGB: 12, teraflops: 11.6, year: 2021 },
          { id: 'rx-6750-xt', name: 'Radeon RX 6750 XT', vramGB: 12, teraflops: 11.9, year: 2022 },
          { id: 'rx-6800', name: 'Radeon RX 6800', vramGB: 16, teraflops: 16.2, year: 2020 },
          { id: 'rx-6800-xt', name: 'Radeon RX 6800 XT', vramGB: 16, teraflops: 20.2, year: 2020 },
          { id: 'rx-6900-xt', name: 'Radeon RX 6900 XT', vramGB: 16, teraflops: 23.0, year: 2020 },
          { id: 'rx-6950-xt', name: 'Radeon RX 6950 XT', vramGB: 16, teraflops: 23.6, year: 2022 },
        ],
      },
      {
        id: 'rx-7000-series',
        name: 'Radeon RX 7000 Series (RDNA 3)',
        years: '2022–2024',
        models: [
          { id: 'rx-7600', name: 'Radeon RX 7600', vramGB: 8, teraflops: 21.5, year: 2023 },
          { id: 'rx-7600-xt', name: 'Radeon RX 7600 XT', vramGB: 16, teraflops: 21.5, year: 2024 },
          { id: 'rx-7700-xt', name: 'Radeon RX 7700 XT', vramGB: 12, teraflops: 35.0, year: 2023 },
          { id: 'rx-7800-xt', name: 'Radeon RX 7800 XT', vramGB: 16, teraflops: 37.3, year: 2023 },
          { id: 'rx-7900-gre', name: 'Radeon RX 7900 GRE', vramGB: 16, teraflops: 45.5, year: 2023 },
          { id: 'rx-7900-xt', name: 'Radeon RX 7900 XT', vramGB: 20, teraflops: 51.6, year: 2022 },
          { id: 'rx-7900-xtx', name: 'Radeon RX 7900 XTX', vramGB: 24, teraflops: 61.0, year: 2022 },
        ],
      },
      {
        id: 'rx-9000-series',
        name: 'Radeon RX 9000 Series (RDNA 4)',
        years: '2025',
        models: [
          { id: 'rx-9070', name: 'Radeon RX 9070', vramGB: 16, teraflops: 44.6, year: 2025 },
          { id: 'rx-9070-xt', name: 'Radeon RX 9070 XT', vramGB: 16, teraflops: 48.7, year: 2025 },
          { id: 'rx-9080-xt', name: 'Radeon RX 9080 XT', vramGB: 24, teraflops: 72.0, year: 2025 },
        ],
      },
    ],
  },

  // ---------- Intel ----------
  {
    id: 'intel',
    name: 'Intel',
    generations: [
      {
        id: 'arc-a-series',
        name: 'Arc A-Series (Alchemist)',
        years: '2022–2023',
        models: [
          { id: 'arc-a310', name: 'Arc A310', vramGB: 4, teraflops: 2.0, year: 2022 },
          { id: 'arc-a380', name: 'Arc A380', vramGB: 6, teraflops: 3.1, year: 2022 },
          { id: 'arc-a580', name: 'Arc A580', vramGB: 8, teraflops: 7.8, year: 2023 },
          { id: 'arc-a750', name: 'Arc A750', vramGB: 8, teraflops: 13.2, year: 2022 },
          { id: 'arc-a770', name: 'Arc A770', vramGB: 16, teraflops: 19.7, year: 2022 },
        ],
      },
      {
        id: 'arc-b-series',
        name: 'Arc B-Series (Battlemage)',
        years: '2024–2025',
        models: [
          { id: 'arc-b570', name: 'Arc B570', vramGB: 10, teraflops: 11.5, year: 2025 },
          { id: 'arc-b580', name: 'Arc B580', vramGB: 12, teraflops: 13.6, year: 2024 },
        ],
      },
    ],
  },

  // ---------- Apple ----------
  {
    id: 'apple',
    name: 'Apple',
    generations: [
      {
        id: 'apple-silicon-gpu',
        name: 'Apple Silicon Integrated (Unified Memory)',
        years: '2020–2025',
        models: [
          { id: 'apple-m1', name: 'Apple M1 GPU', vramGB: 8, teraflops: 2.6, year: 2020 },
          { id: 'apple-m1-pro', name: 'Apple M1 Pro GPU', vramGB: 16, teraflops: 5.2, year: 2021 },
          { id: 'apple-m1-max', name: 'Apple M1 Max GPU', vramGB: 32, teraflops: 10.4, year: 2021 },
          { id: 'apple-m1-ultra', name: 'Apple M1 Ultra GPU', vramGB: 64, teraflops: 20.8, year: 2022 },
          { id: 'apple-m2', name: 'Apple M2 GPU', vramGB: 8, teraflops: 3.6, year: 2022 },
          { id: 'apple-m2-pro', name: 'Apple M2 Pro GPU', vramGB: 16, teraflops: 6.8, year: 2023 },
          { id: 'apple-m2-max', name: 'Apple M2 Max GPU', vramGB: 32, teraflops: 13.6, year: 2023 },
          { id: 'apple-m2-ultra', name: 'Apple M2 Ultra GPU', vramGB: 64, teraflops: 27.2, year: 2023 },
          { id: 'apple-m3', name: 'Apple M3 GPU', vramGB: 8, teraflops: 4.1, year: 2023 },
          { id: 'apple-m3-pro', name: 'Apple M3 Pro GPU', vramGB: 18, teraflops: 5.7, year: 2023 },
          { id: 'apple-m3-max', name: 'Apple M3 Max GPU', vramGB: 36, teraflops: 14.2, year: 2023 },
          { id: 'apple-m4', name: 'Apple M4 GPU', vramGB: 16, teraflops: 4.3, year: 2024 },
          { id: 'apple-m4-pro', name: 'Apple M4 Pro GPU', vramGB: 24, teraflops: 9.2, year: 2024 },
          { id: 'apple-m4-max', name: 'Apple M4 Max GPU', vramGB: 36, teraflops: 17.8, year: 2024 },
        ],
      },
    ],
  },

  // ---------- Custom ----------
  {
    id: 'custom',
    name: 'Custom / Unlisted GPU',
    generations: [], // UI shows manual VRAM / teraflops inputs
  },
];

// ------------------------------------------------------------
// Platform option lists
// ------------------------------------------------------------

export const RAM_OPTIONS: number[] = [
  2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512,
];

export const STORAGE_OPTIONS: { id: 'hdd' | 'sata-ssd' | 'nvme' | 'nvme-gen4' | 'nvme-gen5'; label: string }[] = [
  { id: 'hdd', label: 'HDD (5400/7200 RPM)' },
  { id: 'sata-ssd', label: 'SATA SSD' },
  { id: 'nvme', label: 'NVMe Gen3' },
  { id: 'nvme-gen4', label: 'NVMe Gen4' },
  { id: 'nvme-gen5', label: 'NVMe Gen5' },
];

export const OS_OPTIONS: { id: 'windows' | 'macos' | 'linux'; label: string }[] = [
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
];
