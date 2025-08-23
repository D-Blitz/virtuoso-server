import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// routes
import facilitatorRoutes from './routes/facilitator.routes';
import roomRoutes from './routes/room.routes';
import serviceRoutes from './routes/service.routes';
import tagRoutes from './routes/tag.routes';
import clientRoutes from './routes/client.routes';
import serviceCategoryRoutes from './routes/serviceCategory.routes';
import scheduledEventRoutes from './routes/scheduledEvent.routes';
import locationRoutes from './routes/location.routes';
import contextRoutes from './routes/context.routes';
import scheduledEventValidationRoutes from './routes/validation/scheduledEventValidation.routes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/facilitators', facilitatorRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/service-categories', serviceCategoryRoutes);
app.use('/api/scheduled-events', scheduledEventRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/context', contextRoutes);
app.use('/api/validation/scheduled-events', scheduledEventValidationRoutes);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
