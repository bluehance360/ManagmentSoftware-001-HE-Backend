const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10) || 587,
  secure: false, // STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send an invitation email with a link to create an account.
 * @param {Object} opts
 * @param {string} opts.to      - Recipient email
 * @param {string} opts.role    - Assigned role label
 * @param {string} opts.token   - Invitation token
 * @param {string} opts.invitedByName - Name of the admin who invited
 */
async function sendInvitationEmail({ to, role, token, invitedByName }) {
  const frontendUrl = process.env.CORS_ORIGIN || 'http://localhost:5173';
  const acceptUrl = `${frontendUrl}/accept-invite?token=${token}`;

  const roleLabelMap = {
    ADMIN: 'Administrator',
    OFFICE_MANAGER: 'Office Manager',
    TECHNICIAN: 'Technician',
  };
  const roleLabel = roleLabelMap[role] || role;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:#C41E2A;padding:28px 32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Hosanna Electric</h1>
              <p style="margin:6px 0 0;color:#fecaca;font-size:13px;">Field Service Management</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 8px;color:#1a1a1a;font-size:18px;">You've been invited!</h2>
              <p style="margin:0 0 20px;color:#6b7280;font-size:14px;line-height:1.6;">
                <strong>${invitedByName}</strong> has invited you to join <strong>Hosanna Electric</strong> as
                <strong style="color:#C41E2A;">${roleLabel}</strong>.
              </p>
              <p style="margin:0 0 24px;color:#6b7280;font-size:14px;line-height:1.6;">
                Click the button below to create your account. This invitation expires in <strong>7 days</strong>.
              </p>
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="${acceptUrl}" target="_blank"
                       style="display:inline-block;padding:14px 36px;background-color:#C41E2A;color:#ffffff;
                              text-decoration:none;font-size:15px;font-weight:600;border-radius:8px;">
                      Create My Account
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;text-align:center;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${acceptUrl}" style="color:#C41E2A;word-break:break-all;">${acceptUrl}</a>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:11px;">
                &copy; ${new Date().getFullYear()} Hosanna Electric. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Hosanna Electric'}" <${process.env.SMTP_FROM_EMAIL || 'noreply@example.com'}>`,
    to,
    subject: `You're invited to join Hosanna Electric as ${roleLabel}`,
    html,
  });
}

module.exports = { sendInvitationEmail };
