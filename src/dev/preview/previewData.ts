import type { ClassificationNode } from '@/hooks/useClassifications';
import type { StationWithWarehouses } from '@/hooks/useStationsDirectory';

/**
 * Review data for `src/dev/preview`, mirroring `supabase/seed.sql` row for row
 * (names, `CLS-00x` codes and the active/disabled mix). Kept in its own module
 * so the harness entry stays a bootstrap and the fixture is easy to diff
 * against the seed when either changes.
 */

const CLASSIFICATIONS: readonly ClassificationNode[] = [
  {
    id: 'preview-c1',
    code: 'CLS-001',
    name: 'المواد والمستلزمات',
    level: 1,
    isLeaf: false,
    isActive: true,
    children: [
      {
        id: 'preview-g1',
        code: 'CLS-003',
        name: 'المواد الخام',
        level: 2,
        isLeaf: false,
        isActive: true,
        children: [
          {
            id: 'preview-i1',
            code: 'CLS-006',
            name: 'حديد وصلب',
            level: 3,
            isLeaf: true,
            isActive: true,
            children: [],
          },
          {
            id: 'preview-i2',
            code: 'CLS-007',
            name: 'أخشاب',
            level: 3,
            isLeaf: true,
            isActive: true,
            children: [],
          },
          {
            id: 'preview-i3',
            code: 'CLS-008',
            name: 'بلاستيك ومطاط',
            level: 3,
            isLeaf: true,
            isActive: false,
            children: [],
          },
        ],
      },
      {
        id: 'preview-g2',
        code: 'CLS-004',
        name: 'مستلزمات التشغيل',
        level: 2,
        isLeaf: false,
        isActive: true,
        children: [
          {
            id: 'preview-i4',
            code: 'CLS-009',
            name: 'زيوت وشحوم',
            level: 3,
            isLeaf: true,
            isActive: true,
            children: [],
          },
          {
            id: 'preview-i5',
            code: 'CLS-010',
            name: 'قطع غيار',
            level: 3,
            isLeaf: true,
            isActive: true,
            children: [],
          },
        ],
      },
    ],
  },
  {
    id: 'preview-c2',
    code: 'CLS-002',
    name: 'الخدمات',
    level: 1,
    isLeaf: false,
    isActive: true,
    children: [
      {
        id: 'preview-g3',
        code: 'CLS-005',
        name: 'خدمات الصيانة',
        level: 2,
        isLeaf: false,
        isActive: false,
        children: [
          {
            id: 'preview-i6',
            code: 'CLS-011',
            name: 'صيانة دورية',
            level: 3,
            isLeaf: true,
            isActive: true,
            children: [],
          },
          {
            id: 'preview-i7',
            code: 'CLS-012',
            name: 'إصلاح أعطال',
            level: 3,
            isLeaf: true,
            isActive: true,
            children: [],
          },
        ],
      },
    ],
  },
];

const STATIONS: readonly StationWithWarehouses[] = [
  {
    id: 'preview-s1',
    code: 'ST-01',
    name: 'المحطة الرئيسية',
    isActive: true,
    warehouses: [
      { id: 'preview-w1', code: 'WH-001', name: 'مخزن المواد الخام', isActive: true },
      { id: 'preview-w2', code: 'WH-002', name: 'مخزن قطع الغيار', isActive: true },
      { id: 'preview-w3', code: 'WH-003', name: 'مخزن المرتجعات', isActive: false },
    ],
  },
  {
    id: 'preview-s2',
    code: 'ST-02',
    name: 'محطة الصيانة',
    isActive: true,
    warehouses: [{ id: 'preview-w4', code: 'WH-004', name: 'مخزن العدد والأدوات', isActive: true }],
  },
  {
    id: 'preview-s3',
    code: 'ST-03',
    name: 'محطة الوقود الشمالية',
    isActive: false,
    warehouses: [],
  },
];

export { CLASSIFICATIONS, STATIONS };
