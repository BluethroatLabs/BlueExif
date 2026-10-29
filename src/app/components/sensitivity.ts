import type { Sensitivity } from '../../engine/core/types';
import type { IconName } from './Icon';

/** Risk levels map onto the Bluethroat status palette (malicious / suspicious / neutral). */
export type Risk = 'high' | 'medium' | 'low';

export const SENS: Record<Sensitivity, { label: string; icon: IconName; hint: string; risk: Risk }> = {
  location: { label: 'Location', icon: 'pin', hint: 'GPS coordinates and place names', risk: 'high' },
  identity: { label: 'People', icon: 'user', hint: 'Names, accounts, e-mail, owners', risk: 'high' },
  device: { label: 'Device', icon: 'camera', hint: 'Make, model, serial numbers', risk: 'medium' },
  time: { label: 'Dates', icon: 'clock', hint: 'When it was made or edited', risk: 'medium' },
  software: { label: 'Software', icon: 'cpu', hint: 'Apps, versions, edit history', risk: 'low' },
  content: { label: 'Content', icon: 'text', hint: 'Descriptions, comments, previews', risk: 'low' },
};

export const SENS_ORDER: Sensitivity[] = ['location', 'identity', 'device', 'time', 'software', 'content'];

/** Categories removed by "Remove personal data" unless the user changes them. */
export const DEFAULT_PERSONAL: Sensitivity[] = ['location', 'identity', 'device'];

/** CSS class for a status tag of the given risk. */
export const RISK_TAG: Record<Risk, string> = { high: 'tag malicious', medium: 'tag suspicious', low: 'tag neutral' };
