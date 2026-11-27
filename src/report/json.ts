import type { Report } from '../model/types.js';

export const renderJson = (report: Report): string => `${JSON.stringify(report, null, 2)}\n`;
