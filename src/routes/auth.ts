import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../database/init';
import { getMergedAccessForUser } from '../utils/userAccess';
import { generateId } from '../utils/helpers';
import { authenticate, AuthRequest, authorize } from '../middleware/auth';

export const authRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

function mapUserResponse(user: any) {
  const access = getMergedAccessForUser(user.id, user.role_id);
  const primary = access.roles.find((r) => r.id === access.primary_role_id) || access.roles[0];

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    avatar: user.avatar,
    user_type: user.user_type,
    institution_id: user.institution_id,
    institution_name: user.institution_name,
    institution_code: user.institution_code,
    institution_logo: user.logo,
    institution_website: user.website,
    institution_motto: user.motto,
    primary_color: user.primary_color,
    secondary_color: user.secondary_color,
    accent_color: user.accent_color,
    role: {
      id: primary?.id || user.role_id,
      code: primary?.code || user.role_code,
      name: primary?.name || user.role_name,
      display_name: primary?.name || user.role_name,
    },
    roles: access.roles,
    role_codes: access.role_codes,
    permissions: access.permissions,
    branch: user.branch_id
      ? {
          id: user.branch_id,
          name: user.branch_name,
        }
      : null,
  };
}

const USER_SELECT = `
  SELECT u.*,
         r.role_code, r.role_name,
         i.institution_name, i.institution_code, i.logo, i.website, i.motto,
         i.primary_color, i.secondary_color, i.accent_color,
         b.branch_name
  FROM users u
  LEFT JOIN roles r ON u.role_id = r.id
  LEFT JOIN institutions i ON u.institution_id = i.id
  LEFT JOIN branches b ON u.branch_id = b.id
`;

// Public: school branding for login page (by institution code)
authRouter.get('/branding', (req: Request, res: Response) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) {
      res.json({ branding: null });
      return;
    }

    const db = getDatabase();
    const branding = db.prepare(`
      SELECT institution_name, institution_code, logo, website, motto,
             primary_color, secondary_color, accent_color
      FROM institutions
      WHERE LOWER(institution_code) = LOWER(?) AND is_active = 1
      LIMIT 1
    `).get(code);

    res.json({ branding: branding || null });
  } catch (error: any) {
    console.error('Branding lookup error:', error);
    res.status(500).json({ error: 'Failed to load branding' });
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const db = getDatabase();
    const identifier = (username || '').trim().toLowerCase();
    const user = db.prepare(`
      ${USER_SELECT}
      WHERE u.is_active = 1
        AND (LOWER(u.username) = ? OR LOWER(u.email) = ?)
      LIMIT 1
    `).get(identifier, identifier) as any;

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({
      userId: user.id,
      institutionId: user.institution_id,
      userType: user.user_type,
    }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      token,
      user: mapUserResponse(user),
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const db = getDatabase();

    const user = db.prepare(`
      ${USER_SELECT}
      WHERE u.id = ? AND u.is_active = 1
    `).get(decoded.userId) as any;

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json(mapUserResponse(user));
  } catch (error: any) {
    console.error('Auth error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

authRouter.post('/logout', (_req: Request, res: Response) => {
  res.json({ message: 'Logged out successfully' });
});

/** Change password. Students create a pending request; others apply immediately. */
authRouter.post('/change-password', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      res.status(400).json({ error: 'current_password and new_password are required' });
      return;
    }
    if (String(new_password).length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters' });
      return;
    }

    const db = getDatabase();
    const user = db.prepare('SELECT id, password_hash, user_type, institution_id FROM users WHERE id = ?')
      .get(req.user!.id) as any;
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const newHash = bcrypt.hashSync(new_password, 10);

    if (user.user_type === 'student') {
      // Reject duplicate pending
      const pending = db.prepare(`
        SELECT id FROM password_change_requests
        WHERE user_id = ? AND status = 'pending'
      `).get(user.id);
      if (pending) {
        res.status(409).json({ error: 'A password change request is already pending admin approval' });
        return;
      }
      const id = generateId();
      db.prepare(`
        INSERT INTO password_change_requests (id, institution_id, user_id, new_password_hash, status)
        VALUES (?, ?, ?, ?, 'pending')
      `).run(id, user.institution_id, user.id, newHash);
      res.json({
        message: 'Password change submitted for admin approval',
        requires_approval: true,
        request_id: id,
      });
      return;
    }

    db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newHash, user.id);
    res.json({ message: 'Password updated successfully', requires_approval: false });
  } catch (error: any) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

authRouter.get('/password-requests', authenticate, authorize('platform_admin', 'institution_admin'), (req: AuthRequest, res: Response) => {
  const db = getDatabase();
  const status = (req.query.status as string) || 'pending';
  const institutionFilter = req.user?.user_type === 'platform_admin' && !req.user.institution_id
    ? '1=1'
    : `pcr.institution_id = '${req.user?.institution_id}'`;

  const rows = db.prepare(`
    SELECT pcr.*, u.username, u.first_name, u.last_name, u.user_type, u.email
    FROM password_change_requests pcr
    JOIN users u ON u.id = pcr.user_id
    WHERE ${institutionFilter} AND pcr.status = ?
    ORDER BY pcr.requested_at DESC
  `).all(status);

  res.json({ data: rows });
});

authRouter.post('/password-requests/:id/approve', authenticate, authorize('platform_admin', 'institution_admin'), (req: AuthRequest, res: Response) => {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM password_change_requests WHERE id = ?`).get(req.params.id) as any;
  if (!row || row.status !== 'pending') {
    res.status(404).json({ error: 'Pending request not found' });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(row.new_password_hash, row.user_id);
    db.prepare(`
      UPDATE password_change_requests
      SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).run(req.user!.id, row.id);
  });
  tx();

  res.json({ message: 'Password change approved' });
});

authRouter.post('/password-requests/:id/reject', authenticate, authorize('platform_admin', 'institution_admin'), (req: AuthRequest, res: Response) => {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM password_change_requests WHERE id = ?`).get(req.params.id) as any;
  if (!row || row.status !== 'pending') {
    res.status(404).json({ error: 'Pending request not found' });
    return;
  }

  db.prepare(`
    UPDATE password_change_requests
    SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), rejection_reason = ?
    WHERE id = ?
  `).run(req.user!.id, req.body.reason || null, row.id);

  res.json({ message: 'Password change rejected' });
});
