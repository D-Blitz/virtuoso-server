import { validateScheduledEvent } from '@/validations/scheduledEvent.validation';
import { ScheduledEventInput } from '@/validations/scheduledEvent.validation';

export class ScheduledEventValidationService {
  async validate(data: ScheduledEventInput) {
    return validateScheduledEvent(data);
  }
}
