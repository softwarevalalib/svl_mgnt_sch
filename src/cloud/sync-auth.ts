import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export interface CloudAuthRequest extends Request {
  cloudUser?: {
    userId: string;
    institutionId: string;
    userType?: string;
  };
}

export function authenticateCloud(
  req: CloudAuthRequest,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Cloud authentication is not configured' });
    return;
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as any;
    if (!decoded.userId || !decoded.institutionId) {
      res.status(401).json({ error: 'Token is not enabled for cloud synchronization' });
      return;
    }
    req.cloudUser = {
      userId: decoded.userId,
      institutionId: decoded.institutionId,
      userType: decoded.userType,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
