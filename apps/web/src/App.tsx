import { Route, Routes } from 'react-router-dom';
import { BaseDocumentPage } from './documents/BaseDocumentPage';
import { DocumentsPage } from './documents/DocumentsPage';
import { JobPage } from './job/JobPage';
import { JobsPage } from './jobs/JobsPage';
import { Nav } from './Nav';

export function App() {
  return (
    <>
      <Nav />
      <Routes>
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/documents/cv" element={<BaseDocumentPage kind="cv" />} />
        <Route path="/documents/cover-letter" element={<BaseDocumentPage kind="cover_letter" />} />
        <Route path="/jobs/:id" element={<JobPage />} />
        <Route path="*" element={<JobsPage />} />
      </Routes>
    </>
  );
}
