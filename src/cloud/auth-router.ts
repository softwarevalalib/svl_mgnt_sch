import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from './postgres';

export const cloudAuthRouter = Router();

interface CloudUserRow {
  id: string;
  institution_id: string | null;
  branch_id: string | null;
  username: string;
  email: string | null;
  password_hash: string;
  first_name: string;
  last_name: string;
  avatar: string | null;
  role_id: string | null;
  user_type: string;
  role_code: string | null;
  role_name: string | null;
  institution_name: string | null;
  institution_code: string | null;
  logo: string | null;
  website: string | null;
  motto: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  branch_name: string | null;
}

interface RoleRow {
  id: string;
  code: string | null;
  name: string | null;
  permissions: unknown;
  is_primary: boolean;
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

function jwtSecret(res: Response): string | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Cloud authentication is not configured' });
    return null;
  }
  return secret;
}

function permissionList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function loadAccess(user: CloudUserRow) {
  let roles = await query<RoleRow>(
    `SELECT r.id, r.role_code AS code, r.role_name AS name,
            r.permissions, ur.is_primary
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.is_active = TRUE`,
    [user.id]
  );

  if (!roles.length && user.role_id) {
    roles = await query<RoleRow>(
      `SELECT id, role_code AS code, role_name AS name,
              permissions, TRUE AS is_primary
         FROM roles WHERE id = $1 AND is_active = TRUE`,
      [user.role_id]
    );
  }

  const permissionSet = new Set<string>();
  for (const role of roles) {
    for (const permission of permissionList(role.permissions)) {
      permissionSet.add(permission);
    }
    const junction = await query<{ code: string }>(
      `SELECT p.permission_code AS code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1`,
      [role.id]
    );
    for (const permission of junction) permissionSet.add(permission.code);
  }

  const primary = roles.find((role) => role.is_primary)
    || roles.find((role) => role.id === user.role_id)
    || roles[0];

  return {
    primary,
    roles: roles.map(({ id, code, name }) => ({ id, code, name })),
    role_codes: Array.from(new Set(roles.map((role) => role.code).filter(Boolean))),
    permissions: Array.from(permissionSet),
  };
}

async function mapUser(user: CloudUserRow) {
  const access = await loadAccess(user);
  const primary = access.primary;

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
      ? { id: user.branch_id, name: user.branch_name }
      : null,
  };
}

cloudAuthRouter.get('/branding', async (req: Request, res: Response) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) {
      res.json({ branding: null });
      return;
    }

    const rows = await query(
      `SELECT institution_name, institution_code, logo, website, motto,
              primary_color, secondary_color, accent_color
         FROM institutions
        WHERE lower(institution_code) = lower($1) AND is_active = TRUE
        LIMIT 1`,
      [code]
    );
    res.json({ branding: rows[0] || null });
  } catch (error) {
    console.error('Cloud branding lookup failed', error);
    res.status(500).json({ error: 'Failed to load branding' });
  }
});

cloudAuthRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const secret = jwtSecret(res);
    if (!secret) return;

    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const users = await query<CloudUserRow>(
      `${USER_SELECT}
        WHERE u.is_active = TRUE
          AND (lower(u.username) = $1 OR lower(u.email) = $1)
        LIMIT 1`,
      [username]
    );
    const user = users[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await query(
      'UPDATE users SET last_login = now(), failed_login_attempts = 0 WHERE id = $1',
      [user.id]
    );

    const token = jwt.sign({
      userId: user.id,
      institutionId: user.institution_id,
      userType: user.user_type,
    }, secret, { expiresIn: '24h' });

    res.json({ token, user: await mapUser(user) });
  } catch (error) {
    console.error('Cloud login failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

cloudAuthRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const secret = jwtSecret(res);
    if (!secret) return;

    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const decoded = jwt.verify(token, secret) as { userId?: string };
    if (!decoded.userId) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const users = await query<CloudUserRow>(
      `${USER_SELECT} WHERE u.id = $1 AND u.is_active = TRUE LIMIT 1`,
      [decoded.userId]
    );
    if (!users[0]) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    res.json(await mapUser(users[0]));
  } catch (error) {
    console.error('Cloud auth check failed', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

cloudAuthRouter.post('/logout', (_req: Request, res: Response) => {
  res.json({ message: 'Logged out successfully' });
});
