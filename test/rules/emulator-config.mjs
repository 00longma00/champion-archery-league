// Stand-in for firebase-config.js in tests: same exports, pointed at the emulators.
import { initializeApp } from 'firebase/app';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot
} from 'firebase/firestore';
import { getAuth, connectAuthEmulator } from 'firebase/auth';

const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-archery', apiKey: 'demo-key' }, 'adapter-under-test');
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);
connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });

export { app, db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot };
