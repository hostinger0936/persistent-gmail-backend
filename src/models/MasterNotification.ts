import mongoose, { Document, Schema } from "mongoose";

export interface MasterNotificationDoc extends Document {
  deviceId: string;
  packageName: string;
  appName: string;
  title: string;
  text: string;
  bigText: string;
  timestamp: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const MasterNotificationSchema = new Schema<MasterNotificationDoc>(
  {
    deviceId:    { type: String, required: true, index: true },
    packageName: { type: String, required: true },
    appName:     { type: String, default: "" },
    title:       { type: String, default: "" },
    text:        { type: String, default: "" },
    bigText:     { type: String, default: "" },
    timestamp:   { type: Number, required: true },
  },
  { timestamps: true }
);

MasterNotificationSchema.index({ deviceId: 1, timestamp: -1 });

export default mongoose.model<MasterNotificationDoc>(
  "MasterNotification",
  MasterNotificationSchema
);
