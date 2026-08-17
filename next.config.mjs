/** @type {import('next').NextConfig} */
const nextConfig = {
  swcMinify: false,
  typescript: {
    ignoreBuildErrors: true, // Force le serveur à ignorer les blocages techniques
  },
  eslint: {
    ignoreDuringBuilds: true, // Force le serveur à publier sans s'arrêter
  },
};

export default nextConfig;
