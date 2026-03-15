import express from 'express';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();

// Tabla DynamoDB: atributos Email, Password; opcionales Nombre, id_usuario
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Faltan email o password' });
  }

  const emailNorm = email.trim().toLowerCase();

  try {
    const cmd = new ScanCommand({
      TableName: tables.usuarios,
      FilterExpression: '#Email = :email AND #Password = :password',
      ExpressionAttributeNames: { '#Email': 'Email', '#Password': 'Password' },
      ExpressionAttributeValues: {
        ':email': emailNorm,
        ':password': password,
      },
    });

    const result = await docClient.send(cmd);
    const items = result.Items || [];

    if (items.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = items[0];
    res.json({
      user: {
        id_usuario: user.id_usuario ?? user.Email ?? '',
        email: user.Email ?? '',
        Nombre: user.Nombre ?? user.Email ?? user.email ?? '',
        Rol: user.Rol ?? '',
      },
    });
  } catch (err) {
    console.error('DynamoDB error:', err);
    const message = err.message || 'Error al verificar credenciales';
    res.status(500).json({ error: message });
  }
});

export default router;
