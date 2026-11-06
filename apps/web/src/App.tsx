import { Route, Routes } from 'react-router-dom';
import { DocumentsPage } from './documents/DocumentsPage';
import { JobsPage } from './jobs/JobsPage';
import { Nav } from './Nav';

export function App() {
  return (
    <>
      <Nav />
      <Routes>
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="*" element={<JobsPage />} />
      </Routes>
    </>
  );
}
